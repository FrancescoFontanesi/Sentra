export type ProviderId = 'codex' | 'claude';
export type ObservationCategory = 'usage_point' | 'usage_snapshot' | 'lifecycle' | 'runtime_evidence';
export type RereadReason = 'truncated' | 'replaced' | 'compressed';

export type SourcePosition =
  | { kind: 'byte_range'; byteOffset: number; byteLength: number; lineNumber: number }
  | { kind: 'logical_line'; lineNumber: number; decompressedByteOffset: number; decompressedByteLength: number }
  | { kind: 'document'; fieldPath?: string };

export interface SourceRef {
  path: string;
  logicalKey: string;
  kind: string;
  compressed: boolean;
  generation: number;
  rereadReason?: RereadReason;
  previousPath?: string;
}

export interface NativeIds {
  sessionId?: string;
  threadId?: string;
  parentThreadId?: string;
  turnId?: string;
  rootTurnId?: string;
  responseId?: string;
  uuid?: string;
  parentUuid?: string;
  logicalParentUuid?: string;
  turnPromptId?: string;
  promptId?: string;
  messageId?: string;
  requestId?: string;
  requestRef?: string;
  apiBlockIndex?: number;
  agentId?: string;
  callId?: string;
  toolUseId?: string;
  pid?: number;
}

export interface ObservationEnvelope<TPayload = Record<string, unknown>> {
  provider: ProviderId;
  category: ObservationCategory;
  eventType: string;
  nativeIds: NativeIds;
  timestamp?: string | number;
  harnessVersion?: string;
  source: SourceRef;
  position: SourcePosition;
  payload: TPayload;
}

export type DiagnosticCode =
  | 'malformed_json'
  | 'incomplete_trailing_line'
  | 'unknown_event_type'
  | 'zstd_error'
  | 'zstd_truncated_or_empty'
  | 'zstd_unsupported_runtime'
  | 'source_unreadable'
  | 'source_removed'
  | 'source_replaced_or_truncated'
  | 'source_compressed_transition'
  | 'sensitive_path_blocked';

export interface DiagnosticEvent {
  severity: 'info' | 'warn' | 'error';
  code: DiagnosticCode;
  provider: ProviderId;
  sourcePath: string;
  position?: SourcePosition;
  message: string;
}

export interface SourceCursor {
  canonicalPath: string;
  logicalKey: string;
  compressed: boolean;
  dev: bigint;
  ino: bigint;
  size: number;
  mtimeMs: number;
  byteOffset: number;
  lineNumber: number;
  headerFingerprint: string;
  headerFingerprintLength: number;
  generation: number;
}

export interface DiscoveredSource {
  provider: ProviderId;
  path: string;
  logicalKey: string;
  kind: string;
  compressed: boolean;
  watchable: boolean;
}

export interface AcquisitionBatch<TPayload = Record<string, unknown>> {
  observations: Array<ObservationEnvelope<TPayload>>;
  diagnostics: DiagnosticEvent[];
  filesScanned: number;
  filesRead: number;
  filesSkippedUnchanged: number;
}

export type JsonObject = Record<string, unknown>;

export const asObj = (v: unknown): JsonObject | undefined =>
  v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as JsonObject) : undefined;
export const asStr = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
export const asNum = (v: unknown): number | undefined =>
  typeof v === 'number' && Number.isFinite(v) ? v : undefined;
export const asTs = (v: unknown): string | number | undefined =>
  typeof v === 'string' || (typeof v === 'number' && Number.isFinite(v)) ? v : undefined;

/** Copies only allowlisted keys whose values are defined (preserving 0, false, null). */
export function pick(src: JsonObject, keys: readonly string[]): JsonObject {
  const out: JsonObject = {};
  for (const k of keys) {
    if (src[k] !== undefined) out[k] = src[k];
  }
  return out;
}

/** Copies only numeric allowlisted fields (preserving 0, omitting missing/non-numeric). */
export function pickNums(src: unknown, keys: readonly string[]): Record<string, number> | undefined {
  const obj = asObj(src);
  if (!obj) return undefined;
  const out: Record<string, number> = {};
  for (const k of keys) {
    const n = asNum(obj[k]);
    if (n !== undefined) out[k] = n;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

export function compactIds(ids: NativeIds): NativeIds {
  const out: Record<string, string | number> = {};
  for (const [k, v] of Object.entries(ids)) {
    if (v !== undefined) out[k] = v as string | number;
  }
  return out;
}
