import crypto from 'node:crypto';
import fs from 'node:fs';
import zlib from 'node:zlib';
import { isSensitivePath, normalizeFsPath, resolveCanonicalPath } from './paths.js';
import type {
  DiagnosticCode,
  DiagnosticEvent,
  DiscoveredSource,
  RereadReason,
  SourceCursor,
  SourcePosition,
  SourceRef,
} from './types.js';

const HEADER_BYTES = 256;
const LF = 0x0a;
const CR = 0x0d;

export interface ParsedLineRecord {
  value: unknown;
  position: SourcePosition;
}

export interface JsonlReadResult {
  skippedUnchanged: boolean;
  sourceRef: SourceRef;
  records: ParsedLineRecord[];
  diagnostics: DiagnosticEvent[];
}

export interface JsonSnapshotResult {
  skippedUnchanged: boolean;
  sourceRef: SourceRef;
  data?: unknown;
  diagnostics: DiagnosticEvent[];
}

/** In-memory cursor store separating physical path from compression-independent `logicalKey`. */
export class SourceCursorStore {
  private readonly byPath = new Map<string, SourceCursor>();
  private readonly byLogical = new Map<string, string>();

  getByPath(p: string): SourceCursor | undefined {
    return this.byPath.get(p);
  }

  getByLogicalKey(k: string): SourceCursor | undefined {
    const p = this.byLogical.get(k);
    return p ? this.byPath.get(p) : undefined;
  }

  set(c: SourceCursor): void {
    this.byPath.set(c.canonicalPath, c);
    this.byLogical.set(c.logicalKey, c.canonicalPath);
  }

  removeByPath(p: string): void {
    const existing = this.byPath.get(p);
    if (!existing) return;
    this.byPath.delete(p);
    if (this.byLogical.get(existing.logicalKey) === p) this.byLogical.delete(existing.logicalKey);
  }
}

function diag(
  severity: DiagnosticEvent['severity'],
  code: DiagnosticCode,
  source: DiscoveredSource,
  sourcePath: string,
  message: string,
  position?: SourcePosition
): DiagnosticEvent {
  return position
    ? { severity, code, provider: source.provider, sourcePath, position, message }
    : { severity, code, provider: source.provider, sourcePath, message };
}

function makeRef(
  source: DiscoveredSource,
  canonicalPath: string,
  generation: number,
  rereadReason?: RereadReason,
  previousPath?: string
): SourceRef {
  return {
    path: canonicalPath,
    logicalKey: source.logicalKey,
    kind: source.kind,
    compressed: source.compressed,
    generation,
    ...(rereadReason ? { rereadReason } : {}),
    ...(previousPath ? { previousPath } : {}),
  };
}

async function hashHeader(filePath: string, maxBytes: number): Promise<{ hash: string; length: number }> {
  if (maxBytes <= 0) return { hash: '', length: 0 };
  const handle = await fs.promises.open(filePath, 'r');
  try {
    const buf = Buffer.allocUnsafe(maxBytes);
    const { bytesRead } = await handle.read(buf, 0, maxBytes, 0);
    return bytesRead === 0
      ? { hash: '', length: 0 }
      : { hash: crypto.createHash('sha256').update(buf.subarray(0, bytesRead)).digest('hex'), length: bytesRead };
  } finally {
    await handle.close();
  }
}

async function resolveAndStat(
  source: DiscoveredSource,
  cursors: SourceCursorStore,
  diagnostics: DiagnosticEvent[]
): Promise<{ canonicalPath: string; stat?: fs.BigIntStats }> {
  const norm = normalizeFsPath(source.path);
  if (isSensitivePath(norm)) {
    diagnostics.push(diag('error', 'sensitive_path_blocked', source, norm, 'Blocked read on sensitive path'));
    return { canonicalPath: norm };
  }
  const canonicalPath = await resolveCanonicalPath(norm);
  if (isSensitivePath(canonicalPath)) {
    diagnostics.push(diag('error', 'sensitive_path_blocked', source, canonicalPath, 'Blocked read on sensitive canonical path'));
    return { canonicalPath };
  }
  try {
    return { canonicalPath, stat: await fs.promises.stat(canonicalPath, { bigint: true }) };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      cursors.removeByPath(canonicalPath);
      diagnostics.push(diag('info', 'source_removed', source, canonicalPath, 'Source file removed'));
    } else {
      diagnostics.push(diag('warn', 'source_unreadable', source, canonicalPath, `Unable to stat (${code ?? 'unknown'})`));
    }
    return { canonicalPath };
  }
}

async function consumeJsonlStream(
  stream: NodeJS.ReadableStream,
  source: DiscoveredSource,
  sourcePath: string,
  initialOffset: number,
  initialLine: number,
  flagTrailingEof: boolean,
  onRecord?: (rec: ParsedLineRecord) => void
) {
  const records: ParsedLineRecord[] = [];
  const diagnostics: DiagnosticEvent[] = [];
  let offset = initialOffset;
  let lineNumber = initialLine;
  let totalBytes = 0;
  let pending: Buffer[] = [];
  let pendingLen = 0;

  const makePos = (start: number, len: number, line: number): SourcePosition =>
    source.compressed
      ? { kind: 'logical_line', lineNumber: line, decompressedByteOffset: start, decompressedByteLength: len }
      : { kind: 'byte_range', byteOffset: start, byteLength: len, lineNumber: line };

  const emitLine = (buf: Buffer, rawLen: number): void => {
    const pos = makePos(offset, rawLen, ++lineNumber);
    offset += rawLen;
    const end = buf.length > 0 && buf[buf.length - 1] === CR ? buf.length - 1 : buf.length;
    if (end === 0) return;
    const text = buf.subarray(0, end).toString('utf8');
    if (text.trim().length === 0) return;
    try {
      const rec: ParsedLineRecord = { value: JSON.parse(text), position: pos };
      if (onRecord) onRecord(rec);
      else records.push(rec);
    } catch {
      diagnostics.push(diag('warn', 'malformed_json', source, sourcePath, `Malformed JSON at line ${lineNumber}`, pos));
    }
  };

  for await (const raw of stream) {
    const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
    totalBytes += chunk.length;
    let i = 0;
    while (i < chunk.length) {
      const nl = chunk.indexOf(LF, i);
      if (nl === -1) {
        const tail = i === 0 ? chunk : chunk.subarray(i);
        pending.push(Buffer.from(tail));
        pendingLen += tail.length;
        break;
      }
      const seg = chunk.subarray(i, nl);
      if (pendingLen > 0) {
        pending.push(seg);
        emitLine(Buffer.concat(pending, pendingLen + seg.length), pendingLen + seg.length + 1);
        pending = [];
        pendingLen = 0;
      } else {
        emitLine(seg, seg.length + 1);
      }
      i = nl + 1;
    }
  }

  if (pendingLen > 0 && flagTrailingEof) {
    diagnostics.push(
      diag(
        'warn',
        'incomplete_trailing_line',
        source,
        sourcePath,
        `Incomplete trailing line (${pendingLen} bytes) at EOF`,
        makePos(offset, pendingLen, lineNumber + 1)
      )
    );
  }

  return { records, diagnostics, finalOffset: offset, finalLine: lineNumber, totalBytes };
}

export async function readJsonlSource(
  source: DiscoveredSource,
  cursors: SourceCursorStore,
  options: {
    allowZstdOverride?: boolean;
    onRecord?: (record: ParsedLineRecord, sourceRef: SourceRef) => void;
  } = {}
): Promise<JsonlReadResult> {
  const diagnostics: DiagnosticEvent[] = [];
  const { canonicalPath, stat } = await resolveAndStat(source, cursors, diagnostics);
  if (!stat) return { skippedUnchanged: false, sourceRef: makeRef(source, canonicalPath, 0), records: [], diagnostics };

  const size = Number(stat.size);
  const mtimeMs = Number(stat.mtimeMs);
  const prev = cursors.getByPath(canonicalPath);
  const prevLogical = prev ? undefined : cursors.getByLogicalKey(source.logicalKey);

  let startOffset = 0;
  let startLine = 0;
  let generation = prev ? prev.generation : 1;
  let rereadReason: RereadReason | undefined;
  let previousPath: string | undefined;
  let fp = { hash: '', length: 0 };

  if (prev) {
    const sameInode = prev.dev === stat.dev && prev.ino === stat.ino;
    if (source.compressed) {
      if (sameInode && prev.size === size && prev.mtimeMs === mtimeMs) {
        return { skippedUnchanged: true, sourceRef: makeRef(source, canonicalPath, prev.generation), records: [], diagnostics };
      }
      generation = prev.generation + 1;
      rereadReason = 'replaced';
      diagnostics.push(diag('info', 'source_replaced_or_truncated', source, canonicalPath, 'Compressed source changed'));
    } else {
      let headerOk = prev.headerFingerprintLength === 0;
      if (!headerOk && size >= prev.headerFingerprintLength) {
        try {
          const check = await hashHeader(canonicalPath, prev.headerFingerprintLength);
          headerOk = check.length === prev.headerFingerprintLength && check.hash === prev.headerFingerprint;
          if (headerOk && prev.headerFingerprintLength === Math.min(size, HEADER_BYTES)) fp = check;
        } catch (err) {
          diagnostics.push(diag('warn', 'source_unreadable', source, canonicalPath, `Header read failed (${(err as NodeJS.ErrnoException).code ?? 'unknown'})`));
          return { skippedUnchanged: false, sourceRef: makeRef(source, canonicalPath, prev.generation), records: [], diagnostics };
        }
      }
      if (sameInode && headerOk && size === prev.byteOffset) {
        return { skippedUnchanged: true, sourceRef: makeRef(source, canonicalPath, prev.generation), records: [], diagnostics };
      }
      if (sameInode && headerOk && size > prev.byteOffset) {
        startOffset = prev.byteOffset;
        startLine = prev.lineNumber;
      } else {
        generation = prev.generation + 1;
        rereadReason = size < prev.byteOffset ? 'truncated' : 'replaced';
        diagnostics.push(diag('info', 'source_replaced_or_truncated', source, canonicalPath, `Source ${rereadReason}; resetting offset`));
      }
    }
  } else if (prevLogical) {
    generation = prevLogical.generation + 1;
    previousPath = prevLogical.canonicalPath;
    rereadReason = !prevLogical.compressed && source.compressed ? 'compressed' : 'replaced';
    if (rereadReason === 'compressed') {
      diagnostics.push(diag('info', 'source_compressed_transition', source, canonicalPath, 'Transitioned from JSONL to Zstandard archive'));
    }
    cursors.removeByPath(prevLogical.canonicalPath);
  }

  const ref = makeRef(source, canonicalPath, generation, rereadReason, previousPath);
  const saveCursor = (byteOffset: number, lineNumber: number) =>
    cursors.set({
      canonicalPath,
      logicalKey: source.logicalKey,
      compressed: source.compressed,
      dev: stat.dev,
      ino: stat.ino,
      size,
      mtimeMs,
      byteOffset,
      lineNumber,
      headerFingerprint: fp.hash,
      headerFingerprintLength: fp.length,
      generation,
    });

  if (source.compressed) {
    const canZstd = options.allowZstdOverride ?? typeof zlib.createZstdDecompress === 'function';
    if (!canZstd) {
      diagnostics.push(diag('error', 'zstd_unsupported_runtime', source, canonicalPath, 'Native node:zlib Zstandard unavailable'));
      return { skippedUnchanged: false, sourceRef: ref, records: [], diagnostics };
    }
    const fileStream = fs.createReadStream(canonicalPath);
    const zstd = zlib.createZstdDecompress();
    fileStream.on('error', (err) => zstd.destroy(err));
    fileStream.pipe(zstd);
    try {
      const res = await consumeJsonlStream(
        zstd,
        source,
        canonicalPath,
        0,
        0,
        true,
        options.onRecord ? (r) => options.onRecord!(r, ref) : undefined
      );
      diagnostics.push(...res.diagnostics);
      // node:zlib may end with 0 bytes on truncated zstd frames instead of emitting an error.
      if (size > 0 && res.totalBytes === 0) {
        diagnostics.push(diag('warn', 'zstd_truncated_or_empty', source, canonicalPath, `Non-empty archive (${size}B) yielded 0 bytes`));
      }
      saveCursor(size, res.finalLine);
      return { skippedUnchanged: false, sourceRef: ref, records: res.records, diagnostics };
    } catch (err) {
      fileStream.destroy();
      diagnostics.push(diag('error', 'zstd_error', source, canonicalPath, `Zstd failed (${(err as NodeJS.ErrnoException).code ?? 'ZSTD_ERROR'})`));
      return { skippedUnchanged: false, sourceRef: ref, records: [], diagnostics };
    }
  }

  if (fp.length === 0 && size > 0) {
    try {
      fp = await hashHeader(canonicalPath, Math.min(size, HEADER_BYTES));
    } catch (err) {
      diagnostics.push(diag('warn', 'source_unreadable', source, canonicalPath, `Header read failed (${(err as NodeJS.ErrnoException).code ?? 'unknown'})`));
      return { skippedUnchanged: false, sourceRef: ref, records: [], diagnostics };
    }
  }

  if (size === 0 || startOffset >= size) {
    saveCursor(startOffset, startLine);
    return { skippedUnchanged: false, sourceRef: ref, records: [], diagnostics };
  }

  try {
    const res = await consumeJsonlStream(
      fs.createReadStream(canonicalPath, { start: startOffset }),
      source,
      canonicalPath,
      startOffset,
      startLine,
      false,
      options.onRecord ? (r) => options.onRecord!(r, ref) : undefined
    );
    diagnostics.push(...res.diagnostics);
    saveCursor(res.finalOffset, res.finalLine);
    return { skippedUnchanged: false, sourceRef: ref, records: res.records, diagnostics };
  } catch (err) {
    diagnostics.push(diag('warn', 'source_unreadable', source, canonicalPath, `JSONL read failed (${(err as NodeJS.ErrnoException).code ?? 'READ_ERROR'})`));
    return { skippedUnchanged: false, sourceRef: ref, records: [], diagnostics };
  }
}

export async function readJsonSnapshot(
  source: DiscoveredSource,
  cursors: SourceCursorStore
): Promise<JsonSnapshotResult> {
  const diagnostics: DiagnosticEvent[] = [];
  const { canonicalPath, stat } = await resolveAndStat(source, cursors, diagnostics);
  if (!stat) return { skippedUnchanged: false, sourceRef: makeRef(source, canonicalPath, 0), diagnostics };

  const size = Number(stat.size);
  const mtimeMs = Number(stat.mtimeMs);
  const prev = cursors.getByPath(canonicalPath);
  if (prev && prev.dev === stat.dev && prev.ino === stat.ino && prev.size === size && prev.mtimeMs === mtimeMs) {
    return { skippedUnchanged: true, sourceRef: makeRef(source, canonicalPath, prev.generation), diagnostics };
  }

  const generation = prev ? prev.generation + 1 : 1;
  const ref = makeRef(source, canonicalPath, generation, prev ? 'replaced' : undefined);
  try {
    const data: unknown = JSON.parse(await fs.promises.readFile(canonicalPath, 'utf8'));
    cursors.set({
      canonicalPath,
      logicalKey: source.logicalKey,
      compressed: false,
      dev: stat.dev,
      ino: stat.ino,
      size,
      mtimeMs,
      byteOffset: size,
      lineNumber: 0,
      headerFingerprint: '',
      headerFingerprintLength: 0,
      generation,
    });
    return { skippedUnchanged: false, sourceRef: ref, data, diagnostics };
  } catch (err) {
    const isSyntax = err instanceof SyntaxError;
    diagnostics.push(
      diag(
        'warn',
        isSyntax ? 'malformed_json' : 'source_unreadable',
        source,
        canonicalPath,
        isSyntax ? 'Malformed JSON snapshot' : `Snapshot read failed (${(err as NodeJS.ErrnoException).code ?? 'unknown'})`,
        { kind: 'document' }
      )
    );
    return { skippedUnchanged: false, sourceRef: ref, diagnostics };
  }
}
