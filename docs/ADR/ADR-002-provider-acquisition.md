# ADR-002 — Provider Acquisition

- **Identificativo:** ADR-002
- **Data:** 2026-11-24
- **Stato:** Approved

## Contesto

Completato il bootstrap tecnico del repository in ADR-001 (TypeScript `5.9.3`, `NodeNext` con `"type": "commonjs"`, `engines.vscode: "^1.101.0"`, `node:test`, zero dipendenze runtime), Sentra necessita del sottosistema di **acquisizione passiva e read-only** per i due harness iniziali: **Codex** e **Claude Code**.

Questo ADR definisce esclusivamente discovery delle fonti, lettura storica e incrementale, decompressione Zstandard, estrazione di osservazioni native tipizzate, diagnostica e strategia di testing. Normalizzazione semantica dei token, deduplicazione logica delle inferenze, aggregazioni, grafo delle sessioni, attribuzione gerarchica e persistenza dei cursori/indici sono esplicitamente demandati ad ADR-003.

### Verifica delle fonti locali

Ispezione read-only condotta sull'ambiente locale (senza accesso a credenziali, prompt o database SQLite):

| Provider | Fonte | Stato locale osservato | Note rilevanti |
|---|---|---|---|
| **Codex** | `CODEX_HOME` / `~/.codex` | `CODEX_HOME` non impostata; `~/.codex` presente | Versioni campionate: `0.45.0-alpha.5` (legacy) fino a `0.171.0-alpha.13` |
| **Codex** | `sessions/**/*.jsonl` | `36` file | Rollout attivi/recenti non compressi |
| **Codex** | `sessions/**/*.jsonl.zst` | `360` file | Rollout storici compressi (90,9% di `sessions/`) |
| **Codex** | `archived_sessions/**/*.jsonl.zst` | `145` file (100% `.jsonl.zst`) | Ulteriore storico compresso; totale `505` `.jsonl.zst` locali |
| **Codex** | `session_index.jsonl` | Presente | Chiavi: `id`, `thread_name`, `updated_at` |
| **Codex** | `models_cache.json` | Presente | Chiavi top-level: `client_version`, `fetched_at`, `models`, `identity` (*da escludere*) |
| **Claude Code** | `CLAUDE_CONFIG_DIR` / `~/.claude` | `CLAUDE_CONFIG_DIR` non impostata; `~/.claude` presente | Versioni campionate: `2.1.288`–`2.1.330` |
| **Claude Code** | `projects/<slug>/<sessionId>.jsonl` | `297` file | Transcript principali |
| **Claude Code** | `projects/<slug>/<sessionId>/subagents/agent-<id>.jsonl` | `82` file | Transcript subagent |
| **Claude Code** | `projects/<slug>/<sessionId>/subagents/agent-<id>.meta.json` | `82` file | Chiavi: `agentType`, `model`, `effort`, `pickedEffortModel`, `isBuiltIn`, `launchedWithDefaults`, `spawnDepth`, `toolUseId`, `finished`, `requestNonInteractive`, `description`, `requestShape` |
| **Claude Code** | `sessions/<pid>.json` | `2` file | Chiavi: `pid`, `pidDomain`, `procStart`, `sessionId`, `cwd`, `entrypoint`, `kind`, `name`, `status`, `startedAt`, `updatedAt`, `statusUpdatedAt`, `version` |
| **Claude Code** | `~/.claude.json` | Presente | Contiene `cachedUsageUtilization` (`fetchedAtMs`, `utilization`, `accountUuid` *da escludere*) insieme a molti campi non pertinenti/sensibili da ignorare |

I database SQLite di Codex (`state_5.sqlite`, `logs_2.sqlite`, `thread_history_1.sqlite`, ecc.) non risultano necessari: tutte le osservazioni richieste sono acquisibili da JSONL, `.jsonl.zst`, `session_index.jsonl` e `models_cache.json`.

## Decisione

### 1. Architettura e meccanismo di acquisizione

Un livello condiviso (`src/acquisition/`) gestisce discovery di basso livello, sicurezza dei percorsi, lettura streaming/chunked, decompressione e monitoraggio; due adapter dedicati (`src/providers/codex/`, `src/providers/claude/`) isolano discovery delle fonti e parsing nativo. Nessun event bus, nessun framework di streaming, nessuna gerarchia complessa di classi, nessuna nuova CLI e nessuna scansione automatica all'avvio di `src/extension.ts`.

Due modalità di acquisizione:

- **Historical acquisition:** lettura sequenziale in streaming delle fonti storiche e dei metadati ausiliari.
- **Incremental acquisition:** lettura dei soli nuovi byte aggiunti ai file attivi (`.jsonl`) e rilettura selettiva degli snapshot JSON (`.meta.json`, `sessions/<pid>.json`, `~/.claude.json`, `models_cache.json`) solo quando `size` o `mtimeMs` cambiano.

#### Lettura JSONL a byte e gestione cursori

- **Streaming a chunk:** lettura tramite `fs.createReadStream` a partire da `start: cursor.byteOffset` (per file non compressi), senza mai caricare interi transcript in memoria.
- **Delimitazione a livello byte (`0x0a`):** la ricerca del terminatore `\n` avviene sui buffer grezzi prima della decodifica UTF-8 di ciascuna riga (rimuovendo eventuale `\r` finale). In questo modo le sequenze UTF-8 multi-byte e le righe spezzate tra chunk vengono ricomposte integre senza corruzione.
- **Avanzamento atomico del cursore:** `byteOffset` e `lineNumber` avanzano **solo** dopo una riga terminata da `\n`. Eventuali byte residui privi di newline su un file attivo non vengono parsati né consumati, ma riletti al ciclo successivo quando il writer completa il flush.
- **Righe malformate ed eventi sconosciuti:** una riga completa con JSON invalido avanza comunque il cursore (evitando loop infiniti) ed emette una diagnostica `malformed_json` senza dati sensibili; un tipo di evento non gestito emette una diagnostica aggregabile/sintetica `unknown_event_type` senza interrompere lo stream.
- **Rilevazione del ciclo di vita dei file (cursori in memoria in ADR-002):** ogni `SourceCursor` conserva `canonicalPath`, `dev`, `ino` (BigInt via `fs.promises.stat(..., { bigint: true })`), `size`, `mtimeMs`, `byteOffset`, `lineNumber`, `headerFingerprint` (hash dei primi fino a 256 byte per rilevare sostituzioni in-place anche quando `ino`/`size` coincidono su Windows) e `generation` (contatore monotono).
  - *Invariato:* stessa identità e `size === byteOffset` → nessuna rilettura.
  - *Append:* stessa identità e `size > byteOffset` → lettura incrementale da `byteOffset`.
  - *Troncamento o sostituzione:* `size < byteOffset`, cambio `dev`/`ino` o cambio `headerFingerprint` → reset del cursore a `0`, incremento di `generation`, marcatura `rereadReason: 'truncated' | 'replaced'` sulle osservazioni riemesse.
  - *Compressione (Codex `<stem>.jsonl` → `<stem>.jsonl.zst`):* rilevata quando il `.jsonl` tracciato scompare e compare il corrispondente `.jsonl.zst`; la lettura dell'archivio compresso porta `rereadReason: 'compressed'`.
  - *Rimozione (`ENOENT`):* aggiornamento del cursore in memoria ed emissione di diagnostica `source_removed` senza eccezioni non gestite.

#### Monitoraggio incrementale su Windows

- **`fs.watch` mirato con debounce (200 ms per percorso):** attivato solo sulle directory attive pertinenti (per Codex: `sessions/` e sottodirectory data attive, *non* `archived_sessions/`; per Claude: `projects/`, sottodirectory progetto/subagent attive, `sessions/` e directory padre di `~/.claude.json` filtrata sul solo basename `.claude.json`). Nessun `recursive: true` indiscriminato su `$HOME` o sull'intera root degli harness.
- **Riconciliazione leggera periodica (es. ogni 30 s, configurabile e disattivabile nei test):** gestisce eventi persi, coalescing o `filename: null` tipici di `fs.watch` su Windows eseguendo solo `stat` sui file tracciati e una verifica leggera delle directory attive per nuovi file, senza rileggere file invariati né scansionare archivi storici.

### 2. Supporto Zstandard (`.jsonl.zst`)

Verifica di compatibilità eseguita rispetto al runtime minimo di ADR-001:

- **Runtime minimo (`engines.vscode: "^1.101.0"`):** VS Code `1.101.0` utilizza Electron `35` con **Node.js `22.15.1`**.
- **API nativa `node:zlib`:** `zlib.createZstdDecompress()` è stata introdotta in **Node.js `22.15.0`** (e `23.8.0`). È presente nell'Extension Host locale (`Node 24.22.1`, `Electron 43.8.9`), nell'host di sviluppo (`Node 24.11.1`) ed è già tipizzata in `@types/node@^22.20.5`.
- **Decompressione in streaming:** `fs.createReadStream(file).pipe(zlib.createZstdDecompress())` decodifica i rollout riga per riga senza allocare l'intero archivio in memoria e senza introdurre alcuna dipendenza runtime né addon nativi nel VSIX.
- **Comportamento verificato su archivi corrotti o troncati:**
  - Header/frame corrotti generano un errore di stream (`ZSTD_error_prefix_unknown`), catturato e convertito in diagnostica `zstd_error`.
  - **Criticità osservata empiricamente:** su file `.jsonl.zst` troncati a metà frame (testato a 64 byte e al 50% di un rollout reale), `zlib.createZstdDecompress()` termina lo stream con `'end'` *senza emettere `'error'`* (producendo `0` byte su troncamento iniziale oppure un output privo di `\n` finale su troncamento intermedio).
  - **Mitigazione obbligatoria:** il lettore Zstandard emette `zstd_truncated_or_empty` se `compressedSize > 0 && decompressedBytes === 0`, ed emette `incomplete_trailing_line` se allo stato EOF dello stream decompresso restano byte non terminati da `\n`. È inoltre previsto un controllo difensivo a runtime (`typeof zlib.createZstdDecompress === 'function'`) con diagnostica `zstd_unsupported_runtime`.
- **Decompressione incrementale:** i rollout `.jsonl.zst` di Codex sono archivi storici chiusi (non append-only); la lettura avviene in streaming sequenziale completo per file con posizioni logiche (`logical_line`), senza rilettura se `size`/`mtimeMs`/`ino` restano invariati.
- **Scelta adottata:** utilizzo esclusivo del supporto Zstandard nativo di `node:zlib` (`createZstdDecompress`), mantenendo **zero dipendenze runtime** e invariata la versione minima di VS Code (`^1.101.0`). Non viene introdotta `fzstd` né alcuna dipendenza preventiva.

### 3. Codex Adapter (`src/providers/codex/`)

Fonti scoperte: `CODEX_HOME` (fallback `~/.codex`) → `sessions/**/*.jsonl`, `sessions/**/*.jsonl.zst`, `archived_sessions/**/*.jsonl.zst` (solo historical), più fonti ausiliarie opzionali `session_index.jsonl` e `models_cache.json`.

Osservazioni native estratte (preservando la distinzione tra eventi e senza sommare o ricostruire euristicamente i contatori):

- **Sessione e lifecycle (`lifecycle`):**
  - `session_meta`: `id`, `session_id`, `parent_thread_id`, `cli_version`, `cwd`, `runtime_workspace_roots`, `model_provider`, `context_window`, `originator`, `source`, `thread_source`, `history_mode`, `history_base`, `agent_nickname`, `agent_role`, `agent_path`, `multi_agent_version`, `timestamp`, metadati `git` (esclusi `creator_account_id`, `creator_user_id` e il testo di `base_instructions`).
  - `turn_context`: `turn_id`, `root_turn_id`, `model`, `effort`, `cwd`, `approval_policy`, `sandbox_policy`, `file_system_sandbox_policy`, `collaboration_mode`, `permission_profile`, `active_permission_profile`, `disabled_plugin_ids`, `comp_hash`, `multi_agent_version`.
  - `event_msg/task_started`, `event_msg/task_complete`, `event_msg/turn_aborted`.
  - `compacted`: `window_id`, `window_number`, `first_window_id`, `previous_window_id`, `compaction_response_id`, `latest_token_usage_record`, `replacement_history_metadata`, `resume_metadata` (esclusi contenuti di `replacement_history`, `guardian_history`, `retained_context` e `message`).
  - `session_index.jsonl`: `id`, `thread_name`, `updated_at` (riferimento ausiliario).
- **Usage puntuale (`usage_point`) vs snapshot cumulativi (`usage_snapshot`):**
  - `token_usage_record` (`usage_point`): `session_id`, `thread_id`, `turn_id`, `root_turn_id`, `response_id`, `usage` (puntuale), `turn_token_usage` e `thread_token_usage` (cumulativi contestuali) con tutti i contatori nativi (`input_tokens`, `cached_input_tokens`, `cache_write_input_tokens`, `output_tokens`, `reasoning_output_tokens`, `total_tokens`).
  - `event_msg/token_count` (`usage_snapshot`): `info.last_token_usage`, `info.total_token_usage`, `info.last_usage_includes_reasoning`, `info.model_context_window` e `rate_limits` (`limit_id`, `limit_name`, `plan_type`, `primary`/`secondary` con `used_percent`, `window_minutes`, `resets_at`, `credits`, `individual_limit`, `rate_limit_reached_type`, `spend_control_reached`). Preso separatamente da `token_usage_record` e mai interpretato automaticamente come nuova inferenza.
  - **Rollout legacy privi di `token_usage_record` (es. `0.45.0-alpha.5`):** la fonte di usage osservata è `event_msg/token_count` (unitamente a `turn_context.model` e `session_meta.context_window`); nessuna euristica di ricostruzione del consumo viene applicata in ADR-002.
- **Tool e configurazione runtime (`runtime_evidence`):**
  - `response_item/function_call`, `response_item/custom_tool_call` e `response_item/web_search_call`: solo metadati (`call_id`, `id`, `name`, `namespace`, `status`), escludendo `arguments` e `input`.
  - `response_item/additional_tools`: `id`, `role` e nomi/metadati dei tool dichiarati (senza blob/schemi completi, conservando la posizione nella fonte per analisi on demand).
  - `world_state`: metadati strutturali di stato/configurazione (senza segreti o contenuti testuali).
  - `event_msg/thread_settings_applied`, `inter_agent_communication_metadata`.
  - `models_cache.json`: `client_version`, `fetched_at` e metadati dei modelli (`slug`, `display_name`, `context_window`, `max_context_window`, `effective_context_window_percent`, `default_reasoning_level`, `service_tiers`), escludendo esplicitamente `identity`.

### 4. Claude Code Adapter (`src/providers/claude/`)

Fonti scoperte: `CLAUDE_CONFIG_DIR` (fallback `~/.claude`) → `projects/<slug>/<sessionId>.jsonl`, `projects/<slug>/<sessionId>/subagents/agent-<id>.jsonl`, `*.meta.json`, `sessions/<pid>.json`, più i soli campi di usage/quota da `~/.claude.json`. Il workspace effettivo viene letto da `cwd` nei record, senza mai invertire lo slug della directory.

Osservazioni native estratte (preservando contatori e identificativi di deduplicazione senza sommarli):

- **Sessione e lifecycle (`lifecycle`):**
  - `user`: `sessionId`, `uuid`, `parentUuid`, `turnPromptId`, `promptId`, `promptSource`, `turnOrigin`, `turnPosition`, `turnAttributionKey`, `cwd`, `gitBranch`, `entrypoint`, `isSidechain`, `isMeta`, `isCompactSummary`, `permissionMode`, `permissionDecision`, `toolDenialKind`, `sourceToolUseID`, `sourceToolAssistantUUID`, `mcpMeta`, `sandboxed`, `timestamp`, `version` (esclusi prompt `message` e payload `toolUseResult`).
  - `derived-from`: `sessionId`, `sessions`, `v`.
  - `system:compact_boundary`: `sessionId`, `uuid`, `parentUuid`, `logicalParentUuid`, `cwd`, `compactMetadata`, `isSidechain`, `timestamp`, `version`.
  - `subagent_meta` (`*.meta.json`): `agentId` (da filename), `parentSessionId` (da percorso), `agentType`, `model`, `effort`, `pickedEffortModel`, `isBuiltIn`, `launchedWithDefaults`, `spawnDepth`, `toolUseId`, `finished`, `requestNonInteractive`.
  - `runtime_session` (`sessions/<pid>.json`): `pid`, `pidDomain`, `sessionId`, `cwd`, `entrypoint`, `kind`, `name`, `status`, `startedAt`, `updatedAt`, `statusUpdatedAt`, `version`.
- **Usage puntuale (`usage_point`) vs snapshot (`usage_snapshot`):**
  - `assistant` (`usage_point`, quando `message.usage` è presente): conserva `sessionId`, `uuid`, `parentUuid`, `agentId`, `isSidechain`, `cwd`, `message.id`, `requestId`, `requestRef`, `apiBlockIndex`, `requestedModel`, `message.model`, `advisorModel`, `effort`, `perTurnEffort`, `promptCacheRequested`, `thinkingDurationMs`, `toolInputStreamMs`, `message.stop_reason`, `isApiErrorMessage`, `apiErrorType`, `apiErrorStatus`, metadati di attribuzione (`attributionAgent`, `attributionMcpServer`, `attributionMcpTool`, `attributionPlugin`, `attributionSkill`), presenza/conteggio di blocchi `thinking`, e l'oggetto `message.usage` nativo (`input_tokens`, `output_tokens`, `cache_read_input_tokens`, `cache_creation_input_tokens`, `cache_creation.ephemeral_5m_input_tokens`, `cache_creation.ephemeral_1h_input_tokens`, `service_tier`, `speed`, `inference_geo`, `server_tool_use`, `iterations`, `output_tokens_details`). Nessuna somma né deduplicazione in acquisizione.
  - `cost-state` (`usage_snapshot`): `sessionId`, `startTime`, `totalCostUSD`, `modelUsage`, `hasUnknownModelCost`, durate aggregate (`totalDuration`, `totalAPIDuration`, `totalAPIDurationWithoutRetries`, `totalToolDuration`) e contatori linee. Mai sommato alle inferenze.
  - `quotaLimits` (`usage_snapshot`): estratto sia dal campo `quotaLimits` sui record `assistant` (osservato localmente) sia qualora compaia come evento top-level `quotaLimits`.
  - `cachedUsageUtilization` da `~/.claude.json` (`usage_snapshot`): estratto esclusivamente l'oggetto `cachedUsageUtilization` conservando `fetchedAtMs` originale e le finestre di `utilization` (`five_hour`, `seven_day`, `seven_day_opus`, `seven_day_sonnet`, `extra_usage`, `limits`, `spend`, `pace`, `indicator`), escludendo `accountUuid` e ogni altro campo del file. Marcato esplicitamente come snapshot cached (non real-time).
- **Tool e configurazione runtime (`runtime_evidence`):**
  - Blocchi `tool_use` in `assistant.message.content`: solo `{ id, name }` con riferimento al record `assistant` e agli attributi `attribution*` (escluso `input`, `text` e contenuto `thinking`).
  - `api-request`: `id`, `sessionId`, `agentId`, `shapeHash`, `requestDigest`, `querySource`, `cacheControl`, parametri scalari `params`, `timestamp`, `version` (esclusi `base` e `tail`).
  - `api-request-shape`: `sessionId`, `agentId`, `shapeHash`, `timestamp`, `version` e metadati strutturali sintetici (senza esportare system prompt o schemi integrali; la posizione sorgente consente analisi on demand futura).
  - `tools-used`: `sessionId`, `tools`.
  - `system:stop_hook_summary`: `sessionId`, `uuid`, `parentUuid`, `toolUseID`, `hookCount`, `hookInfos`, `hookErrors`, `failedHookErrorIndexes`, `hasOutput`, `preventedContinuation`, `stopReason`, `timestamp`, `version` (escluso `hookAdditionalContext`).

### 5. Contratto minimale di acquisizione

Contratto condiviso in `src/acquisition/types.ts` (envelope comune + payload discriminato per provider):

```ts
export type ProviderId = 'codex' | 'claude';
export type ObservationCategory =
  | 'usage_point'
  | 'usage_snapshot'
  | 'lifecycle'
  | 'runtime_evidence';

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
  rereadReason?: 'truncated' | 'replaced' | 'compressed';
  previousPath?: string;
}

export interface ObservationEnvelope<TPayload = unknown> {
  provider: ProviderId;
  category: ObservationCategory;
  eventType: string;
  nativeIds: Record<string, string | number | undefined>;
  timestamp?: string | number;
  harnessVersion?: string;
  source: SourceRef;
  position: SourcePosition;
  payload: TPayload;
}
```

- I campi assenti restano `undefined` (mai sostituiti con `0`, distinguendo assenza da valore zero).
- Le diagnostiche (`DiagnosticEvent`) usano codici tipizzati (`malformed_json`, `incomplete_trailing_line`, `unknown_event_type`, `zstd_error`, `zstd_truncated_or_empty`, `zstd_unsupported_runtime`, `source_unreadable`, `source_removed`, `source_replaced_or_truncated`, `source_compressed_transition`, `sensitive_path_blocked`) e non contengono mai righe grezze di transcript, segreti o PII.

### 6. Sicurezza, privacy e percorsi Windows

- **Allowlist + denylist difensiva (`src/acquisition/paths.ts`):** accesso consentito solo ai pattern esplicitamente previsti; blocco esplicito su file sensibili (`auth.json*`, `.credentials.json`, `.env*`, `*.key`, `*.pem`, `*.sqlite*`, `.sandbox-secrets/**`, `shell-snapshots/**`, `file-history/**`).
- **Principio di minimizzazione:** nessun salvataggio di copie di transcript, prompt, conversazioni, system prompt, contenuti `thinking` o argomenti/output dei tool; per `~/.claude.json` si estrae esclusivamente `cachedUsageUtilization` (senza `accountUuid`); per `models_cache.json` si esclude `identity`.
- **Percorsi Windows:** gestione trasparente di prefissi extended-length (`\\?\`), separatori misti, casing preservato (senza assumere case-insensitivity del filesystem), e traversal sicuro di symlink/junction mediante `realpath` con tracciamento dei nodi visitati per prevenire cicli o link rotti.

### 7. Struttura iniziale proposta

```text
src/
├── extension.ts                  (invariato in ADR-002)
├── acquisition/
│   ├── types.ts                  (envelope, SourcePosition, SourceCursor, DiagnosticEvent)
│   ├── paths.ts                  (normalizzazione Windows/symlink/junction, allowlist/denylist)
│   ├── jsonl-reader.ts           (lettura streaming/chunked JSONL & .jsonl.zst, offset, UTF-8)
│   └── watcher.ts                (fs.watch mirato con debounce + riconciliazione leggera)
└── providers/
    ├── codex/
    │   ├── discovery.ts
    │   └── parser.ts
    └── claude/
        ├── discovery.ts
        └── parser.ts
test/
├── bootstrap.test.ts             (esistente)
├── acquisition.test.ts
├── codex-adapter.test.ts
├── claude-adapter.test.ts
└── fixtures/                     (campioni sintetici/anonimizzati, incluso piccolo .jsonl.zst)
```

### 8. Strategia di testing

Stack `node:test` + `node:assert/strict` (ADR-001), eseguibile integralmente fuori dall'Extension Host tramite `npm test`:

- **Unit & integration test su fixture sintetiche/anonimizzate (versionate in `test/fixtures/`):**
  - Discovery Codex e Claude Code (inclusi `CODEX_HOME`, `CLAUDE_CONFIG_DIR`, fallback e `archived_sessions/`).
  - Lettura JSONL completa e incrementale con byte offset, righe divise tra chunk, UTF-8 multi-byte spezzato tra chunk, CRLF, righe parziali senza `\n`, JSON malformato ed eventi sconosciuti.
  - Append, truncation, sostituzione file (incluso cambio contenuto a parità di nome), rimozione e transizione `.jsonl` → `.jsonl.zst`.
  - Decompressione Zstandard valida, corrotta (`ZSTD_error_prefix_unknown`) e troncata (0 byte o troncata a metà riga).
  - Parsing Codex (`session_meta`, `turn_context`, `token_usage_record`, `event_msg/token_count`, legacy senza `token_usage_record`, `compacted`, tool call, `world_state`, `additional_tools`, `session_index`, `models_cache` senza `identity`).
  - Parsing Claude Code (`user`, `assistant` multipli con stessi contatori e ID di deduplicazione, `cache_creation` 5m/1h, `cost-state`, `quotaLimits`, `cachedUsageUtilization` con `fetchedAtMs` senza `accountUuid`, `derived-from`, `system:compact_boundary`, `system:stop_hook_summary`, `tool_use`, `api-request`, `api-request-shape`, `tools-used`, subagent + `.meta.json`, `sessions/<pid>.json`, `cwd` senza inversione slug).
  - Preservazione distinzione `undefined` vs `0` e blocco esplicito delle fonti sensibili.
- **Verifica read-only sulle installazioni locali reali (in fase di implementazione):** eseguita tramite verifica dedicata invocata esplicitamente (non accoppiata al `npm test` portabile), raccogliendo numero di file/eventi acquisiti per provider, anomalie/diagnostiche, tempi di scansione e picco di memoria (RSS/heap), senza salvare né loggare dati sensibili.

## Motivazioni

- **Zero nuove dipendenze runtime:** l'uso di `node:zlib` (`createZstdDecompress`, disponibile da Node `22.15.0`, coperto da VS Code `1.101.0` / Node `22.15.1`) preserva la semplicità di ADR-001 e il packaging VSIX privo di `node_modules` o bundler.
- **Integrità su Windows e sui file troncati:** il delimitatore a livello byte, il fingerprint d'intestazione e il controllo esplicito su EOF troncato in Zstandard risolvono problemi reali verificati direttamente sull'ambiente locale.
- **Confine netto con ADR-003:** mantenere separati `usage_point`, `usage_snapshot`, `lifecycle` e `runtime_evidence` con provenienza completa e `generation`/`rereadReason` fornisce ad ADR-003 tutti gli elementi per deduplicazione, normalizzazione e persistenza senza anticipare euristiche premature.

## Alternative rilevanti

1. **`fzstd@0.1.1` (pure JS, MIT, 65 KB, streaming `Decompress`) al posto o come fallback di `node:zlib`:** elimina la dipendenza dal supporto Zstandard di Node `22.15+` (marcato Experimental su Node 22), ma introduce la prima dipendenza runtime nel `package.json` e nel pacchetto VSIX (e prestazioni inferiori rispetto a `libzstd` nativo di Node).
2. **Polling puro senza `fs.watch`:** più semplice su Windows ma introduce latenza o overhead inutile di `stat`/scansione; `fs.watch` mirato + riconciliazione leggera bilancia reattività e affidabilità.
3. **Lettura dei database SQLite di Codex:** evitata perché richiederebbe `node:sqlite` (sperimentale) o addon nativi, mentre JSONL/`.jsonl.zst` e metadati JSON coprono già integralmente le osservazioni richieste.

## Conseguenze e limitazioni

- `zlib.createZstdDecompress` è etichettato *Stability 1 (Experimental)* in Node `22.15.x` (VS Code `1.101.0`) prima della stabilizzazione in Node `24.x`; se mai emergessero regressioni su una specifica build Electron di VS Code `1.101.x`, sarà possibile inserire `fzstd` dietro la stessa interfaccia di `jsonl-reader.ts`.
- Su Windows `fs.watch` non garantisce la consegna di ogni singolo evento in caso di raffiche rapide; la riconciliazione periodica leggera colma il gap con latenza massima pari all'intervallo di riconciliazione.
- I cursori di `SourceCursorStore` risiedono in memoria; come definito dalla correzione di scope di ADR-003, il flusso ordinario dell'Observatory acquisisce solo la sessione corrente per provider, mentre l'acquisizione storica completa (`acquireCodex` / `acquireClaude`) rimane disponibile on demand (es. per analisi mirate del futuro Harness Auditor).
- Nei rollout subagent Codex che condividono `payload.session_id` con il thread padre, `src/providers/codex/parser.ts` utilizza `payload.id` (`threadId`) come identificativo di sessione del subagent così da preservarne la distinzione dal padre.
- La quota Claude Code da `~/.claude.json` (`cachedUsageUtilization`) riflette l'ultimo fetch registrato da Claude Code (`fetchedAtMs`) e può risultare stantia rispetto allo stato corrente del servizio.
- I rollout Codex legacy (es. `0.45.0-alpha.5`) privi di `token_usage_record` espongono solo `event_msg/token_count`; l'eventuale ricostruzione del consumo puntuale è demandata ad ADR-003.

## Criteri di accettazione

### Fase corrente — Proposta

- [x] Baseline tecnica di ADR-001 rispettata.
- [x] Fonti locali di Codex e Claude Code verificate (inclusi `archived_sessions/`, subagent, `.meta.json`, `sessions/<pid>.json`, `~/.claude.json`).
- [x] Strategia di discovery, lettura incrementale, monitoraggio e decompressione Zstandard definita e verificata rispetto al runtime minimo.
- [x] Contratto di acquisizione e separazione rispetto ad ADR-003 definiti.
- [x] Gestione sicurezza/privacy, percorsi Windows e diagnostiche specificate.
- [x] Strategia di testing proporzionata definita.
- [x] Limiti e questioni aperte documentati.
- [x] ADR salvato in `docs/ADR/ADR-002-provider-acquisition.md` con stato `Proposed`.

### Fase successiva — Implementazione

- [x] Acquisizione funzionante per Codex e Claude Code (`src/acquisition/`, `src/providers/codex/`, `src/providers/claude/`).
- [x] Supporto completo a `.jsonl` e `.jsonl.zst` (incluse mitigazioni per archivi corrotti/troncati).
- [x] Lettura incrementale senza riletture integrali non necessarie e gestione di append, truncation, sostituzione, rimozione e compressione.
- [x] Estrazione delle osservazioni native con provenienza verificabile (`byte_range` / `logical_line` / `document`) e distinzione `undefined` vs `0`.
- [x] Nessun accesso a fonti sensibili né esposizione di prompt/segreti/PII.
- [x] Test automatici (`npm test`), `npm run build` e `npm run typecheck` superati.
- [x] Verifica read-only positiva sulle fonti locali reali con metriche (file, eventi, anomalie, tempi, memoria).
- [x] Nessuna implementazione appartenente ad ADR-003 o attivazione automatica in `src/extension.ts`.
- [x] ADR aggiornato ad `Approved` dopo validazione positiva e commit locale circoscritto (`feat: implement provider acquisition (ADR-002)`).

## Questioni aperte

Nessuna. Tutte le questioni aperte sono state risolte prima dell'implementazione:

1. **Zstandard:** utilizzo esclusivo di `node:zlib` nativo (`createZstdDecompress`), zero dipendenze runtime, `engines.vscode: "^1.101.0"` invariata.
2. **`archived_sessions/` (Codex):** inclusa nella sola acquisizione storica (`mode: 'historical'`), esclusa dal monitoraggio continuativo (`mode: 'incremental'` e `getCodexWatchTargets`).
3. **`~/.claude.json`:** estratto esclusivamente `cachedUsageUtilization` (timestamp e finestre/reset) senza `accountUuid` o altri campi sensibili.
4. **Verifica sulle installazioni reali:** eseguita tramite verifica read-only dedicata, mantenendo `npm test` isolato su fixture sintetiche/anonimizzate.

## Esito della validazione

Validazione completata il 2026-11-24 su Windows (`Node.js v24.11.1`, `npm 11.6.2`, `VS Code 1.147.0`, zero nuove dipendenze):

- **Build, typecheck e packaging:** `npm run build` (`exit 0`), `npm run typecheck` (`exit 0`), verifica con TypeScript `6.0.3` integrato in VS Code (`0` diagnostiche) e `npm run package` (`14` file, `21,26 KB`, nessun test/fixture/dipendenza nel VSIX). `src/extension.ts` e `package.json` invariati rispetto ad ADR-001.
- **Test automatici (`npm test`):** `12/12 pass` (`426 ms`) su `bootstrap.test.ts`, `acquisition.test.ts`, `codex-adapter.test.ts` e `claude-adapter.test.ts`, coprendo percorsi Windows, guard sensibili, UTF-8 multi-byte, CRLF, righe parziali/malformate, append senza riemissioni, truncation/replace/remove, transizione `.jsonl` → `.jsonl.zst` con continuità `logicalKey`/`previousPath`, Zstandard valido/corrotto/troncato, `IncrementalWatcher` e parsing nativo di entrambi i provider.
- **Verifica read-only su installazioni reali (dopo ottimizzazione `pendingChunks` $O(N)$ e callback streaming `onRecord`):**
  - **Codex (storico):** `544` file scansionati e letti (inclusi `505` `.jsonl.zst` tra `sessions/` e `archived_sessions/`) in `13,6 s`; `223.870` osservazioni estratte (`usage_point: 17.575`, `usage_snapshot: 114.774`, `lifecycle: 28.792`, `runtime_evidence: 62.729`); `0` errori Zstandard/JSON; `2` diagnostiche `unknown_event_type` (`retained_context/verified_answer`); memoria al termine `RSS 429,6 MB` / `heapUsed 209,7 MB`. Passaggio incrementale successivo: `399` file scansionati (`archived_sessions/` esclusa), `399` saltati invariati, `0` riletture, `114 ms`.
  - **Claude Code (storico):** `464` file scansionati e letti (`projects/`, subagent, `.meta.json`, `sessions/`, `~/.claude.json`) in `2,27 s`; `61.909` osservazioni estratte (`usage_point: 22.875`, `usage_snapshot: 405`, `lifecycle: 14.311`, `runtime_evidence: 24.318`); `0` eventi sconosciuti; `1` diagnostica `malformed_json` su riga corrotta reale; memoria cumulativa `RSS 473,2 MB` / `heapUsed 265,7 MB`. Passaggio incrementale successivo: `464` file scansionati, `464` saltati invariati, `0` riletture, `249 ms`.
