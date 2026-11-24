# ADR-003 — Data Model & Session-Centric State

- **Identificativo:** ADR-003
- **Data:** 2026-11-24
- **Stato:** Approved *(scope corretto su monitoraggio session-centric)*

## Contesto

ADR-001 (bootstrap estensione VS Code) e ADR-002 (acquisizione passiva read-only per Codex e Claude Code, zero dipendenze runtime) forniscono discovery, lettura JSONL incrementale, decompressione Zstandard nativa e parser specifici per provider.

Sentra non è una piattaforma di analisi storica globale: il suo obiettivo primario è assistere l'utente durante l'utilizzo corrente di **Codex** e **Claude Code**, rendendo osservabili i consumi della sessione attiva e prevenendo sprechi. Una prima implementazione aveva indicizzato e persistito l'intero storico su disco (`1.007` file, `156,9 MB` di JSON, `1,19 GB RSS`), risultando sproporzionata rispetto al caso d'uso reale.

Questo ADR definisce il **modello dati canonico**, la **normalizzazione delle metriche**, la **deduplicazione e riconciliazione idempotente**, la **selezione e ricostruzione session-centric** della sessione corrente per provider e la decisione sulla **persistenza** (stato in memoria). L'Harness Auditor resta un componente separato on demand che potrà riutilizzare direttamente i componenti di acquisizione e parsing di ADR-002 senza richiedere una persistenza globale delle evidenze runtime.

## Decisione

### 1. Flusso operativo session-centric (`src/core/session-monitor.ts`)

Per ciascun provider (`codex`, `claude`), `ProviderSessionMonitor` gestisce esclusivamente la **sessione corrente**:

- **Selezione della sessione corrente (`selectCodexSession` / `selectClaudeSession`):**
  - *Claude Code:* priorità a evidenze runtime attive (`sessions/<pid>.json` con verifica liveness PID) filtrate per `workspace` (`runtime_workspace`), poi runtime attive (`runtime_active`), poi transcript principale più recente del workspace (`workspace_recent`, leggendo solo le prime righe per `cwd`), infine fallback sul transcript principale più recente (`most_recent`). I file `subagents/agent-*.jsonl` non sono mai selezionabili come target primario.
  - *Codex:* stat sui rollout di `sessions/` ordinati per `mtimeMs` e peek della sola prima riga (`session_meta`, sia `.jsonl` sia `.jsonl.zst`) sui candidati più recenti. Priorità a rollout attivi non compressi + `workspace` (`runtime_workspace`), poi attivi (`runtime_active`), poi recenti del workspace (`workspace_recent`), infine fallback (`most_recent`). I rollout subagent (`parent_thread_id` o `source.subagent`) non sono mai selezionabili come target primario.
  - *Ambiguità:* se più sessioni primarie valide competono allo stesso livello di priorità (es. due sessioni attive nello stesso workspace), `ambiguous: true` e la lista `candidates` vengono conservati esplicitamente.
- **Perimetro dei file letti:** una volta scelta la sessione primaria, vengono letti **solo** i segmenti di quella sessione (inclusi eventuali segmenti compressi `.jsonl.zst` in `sessions/` o `archived_sessions/` con lo stesso `sessionId`), i subagent figli di quella sola sessione e — per Claude — `~/.claude.json` per la quota cached di account. Nessuna indicizzazione globale delle altre sessioni storiche.
- **Acquisizione incrementale e cambio sessione:** i refresh successivi sulla stessa sessione leggono solo i nuovi byte tramite `SourceCursorStore` in memoria; al cambio di sessione (`selection.sessionId !== prevId`), lo stato e i cursori della sessione precedente vengono scartati immediatamente evitando accumuli indefiniti, mentre lo stato recente delle quote (scope provider/account) viene preservato separatamente.

### 2. Modello dati provider-neutral (`src/core/model.ts`)

Strutture TypeScript piane in memoria (`SentraState`): `SessionRecord`, `TurnRecord`, `InferenceRecord`, `UsageSnapshotRecord`, `QuotaSnapshotRecord` (scope provider/account, mai attribuite arbitrariamente a una sessione), `LifecycleEventRecord` e `RuntimeEvidenceRecord` (opzionale e on demand, non accumulata nel flusso ordinario dell'Observatory). La provenienza usa `sourceKey` (`logicalKey`) e `position` (`byte_range` / `logical_line` / `document`). I valori assenti restano `undefined`, mai `0`.

### 3. Normalizzazione delle metriche (`src/core/normalize.ts`)

Partizione canonica disgiunta dell'input in tre bucket mutuamente esclusivi (`uncachedInputTokens`, `cacheReadTokens`, `cacheWriteTokens`):

- **Codex (`token_usage_record.usage`):** `totalInputTokens = input_tokens`, `cacheReadTokens = cached_input_tokens`, `cacheWriteTokens = cache_write_input_tokens`, `outputTokens = output_tokens` (include già `reasoning_output_tokens`), `reasoningTokens = reasoning_output_tokens`, `totalTokens = total_tokens`. Se `cache_write_input_tokens > 0`, non si usa `input + output === total` come prova di sovrapposizione: `cacheWriteTokens` resta nativo e `uncachedInputTokens` resta `undefined` (`provenance: 'partial'`).
- **Claude Code (`assistant.message.usage`):** `uncachedInputTokens = input_tokens`, `cacheReadTokens = cache_read_input_tokens`, `cacheWriteTokens = cache_creation_input_tokens` (con breakdown `ephemeral5m`/`ephemeral1h`), `totalInputTokens = input + (cache_read ?? 0) + (cache_creation ?? 0)`, `outputTokens = output_tokens`, `totalTokens = totalInputTokens + outputTokens`. Il campo `output_tokens_details.thinking_tokens` (verificato presente e `<= output_tokens` sul 100% dei `22.865` record non sintetici reali) è preservato come `reasoningTokens` senza risommarlo all'output.

### 4. Deduplicazione, riconciliazione e attribuzione (`src/core/reconcile.ts`)

- **Chiavi canoniche e alias:** `codex:resp:<response_id>` per Codex; `claude:msg:<message.id>` con fallback `claude:req:*` / `claude:ref:*` unificati via `inferenceAliases` per Claude Code.
- **Merge deterministico indipendente dall'ordine:** aggiornamenti streaming fusi con `Math.max` per contatore; duplicati finalizzati discordanti segnalati con `hasConflictingDuplicates: true` e diagnostica `conflicting_duplicate_usage`, senza mai sommare.
- **Sintetici ed errori:** esclusi `<synthetic>` e `isApiErrorMessage === true` privi di consumo; i record di errore con consumo verificabile `> 0` sono preservati (`isApiError: true`).
- **Subagent, fork, rollback e `.jsonl` → `.jsonl.zst`:** subagent Codex (`parent_thread_id` + `threadId` distinto in `codex/parser.ts` e `reconcile.ts`) e subagent Claude (`<parent>:agent:<agentId>`) hanno `SessionRecord` dedicati (`isSubagent: true`, `parentSessionId`, `childSessionIds`) senza mai marcare il padre come subagent e separando `directInferenceIds` da `inheritedInferenceIds`. I rollback (`turn_aborted`) preservano i consumi sostenuti; `realignDerivedOwnership` gestisce `derived-from` out-of-order; la chiave posizione `l:<lineNumber>` rende idempotenti le transizioni `.jsonl` → `.jsonl.zst`.
- **Quote:** compressione dei soli snapshot consecutivi identici (`firstObservedAt`, `lastObservedAt`, `observationCount`), preservando tutte le variazioni effettive di percentuali e finestre di reset (nessuna soglia arbitraria) e separando categorie non equivalenti, con indice $O(1)$.

### 5. Decisione sulla persistenza: stato in memoria (nessuna persistenza globale)

In base alle misurazioni reali su singola sessione:

- **Codex (sessione corrente reale, `11` file / `54,1 MB`, `1.830` inferenze):** selezione `65 ms`, ricostruzione completa `405 ms`, aggiornamento incrementale `65 ms` (`0` file riletti), memoria `RSS 86,0 MB` / `heapUsed 11,4 MB`.
- **Claude Code (mega-sessione reale più grande sul disco, `78` file / `185,7 MB`, `38` subagent, `5.819` inferenze):** selezione `86 ms`, ricostruzione completa `2.150 ms`, aggiornamento incrementale `102 ms` (`0` file riletti), memoria cumulativa di entrambi i provider `RSS 234,3 MB` / `heapUsed 94,3 MB`.

La ricostruzione a freddo della singola sessione è già sufficientemente rapida da non giustificare la complessità operativa di uno storage JSON persistente (lockfile multi-host, recovery di crash, quarantena, gestione versioni schema). Viene quindi adottato **esclusivamente lo stato in memoria** (`0 B` su disco), rimuovendo `src/storage/json-store.ts`, `test/storage.test.ts` e i metodi di serializzazione dei cursori divenuti superflui. Una cache persistente mirata potrà essere rivalutata solo se in futuro emergeranno esigenze concrete non soddisfatte dalla ricostruzione in memoria.

### 6. Organizzazione del codice

```text
src/core/
├── model.ts              (strutture canoniche in memoria)
├── normalize.ts          (normalizzazione token Codex e Claude Code)
├── reconcile.ts          (deduplicazione, attribuzione sessioni/subagent, quote)
└── session-monitor.ts    (selezione sessione corrente, ricostruzione, refresh incrementale, reset su switch)
test/
├── normalize.test.ts
├── reconcile.test.ts
└── session-monitor.test.ts
```

Zero nuove dipendenze, nessuna modifica a `src/extension.ts`.

## Motivazioni

- **Allineamento al perimetro reale di Sentra:** l'Observatory monitora la sessione attiva; evitare l'indicizzazione globale elimina oltre `156 MB` di storage su disco, riduce la RAM di ~5× (`1,19 GB → 234 MB RSS`) e abbatte i tempi di inizializzazione da `~21–33 s` a `0,4–2,2 s` (riduzione del carico di lavoro: `89` file pertinenti invece di `1.007` file storici).
- **Semplicità operativa (Ponytail):** lo stato in memoria elimina lockfile concorrenti, corruzioni di file di cache, migrazioni di schema e `~560` righe di codice/test di persistenza non necessari.
- **Riuso completo di ADR-002:** discovery, streaming JSONL, Zstandard e parser restano integralmente riutilizzabili sia dal monitor session-centric sia dal futuro Harness Auditor on demand.

## Alternative rilevanti

1. **Persistenza globale JSON (`sentra-state.v1.json` + `sentra-evidence.v1.json`):** inizialmente implementata e misurata (`76,9 MB` + `80,0 MB`, `5,7 s` salvataggio), scartata perché risolveva un requisito di analisi storica globale estraneo al perimetro di Sentra.
2. **Cache persistente per sola sessione corrente:** valutata e scartata perché la ricostruzione da zero richiede `~0,4 s` su Codex e `~2,1 s` persino su una mega-sessione Claude da `185 MB` / `78` file, non giustificando complessità di invalidazione e lock concorrenti.

## Conseguenze e limitazioni

- Al riavvio dell'Extension Host, la sessione corrente viene ricostruita in memoria dai suoi file locali (`~0,4 s` Codex, fino a `~2,2 s` per mega-sessioni Claude con decine di subagent).
- La selezione Codex ispeziona l'header (`session_meta`) dei `40` rollout più recenti in `sessions/`; segmenti storici più vecchi della stessa sessione sono recuperati se il filename include `sessionId` (anche in `archived_sessions/`).
- Se due sessioni primarie sono contemporaneamente attive nello stesso workspace, Sentra seleziona la più recente e segnala esplicitamente `ambiguous: true` con `candidates`.
- `cache_write_input_tokens > 0` su provider Codex non nativi lascia `uncachedInputTokens` indefinito (`partial`).

## Criteri di accettazione

- [x] Monitoraggio circoscritto alla sessione corrente per provider (`ProviderSessionMonitor`).
- [x] Consumi ricostruiti dall'inizio della sessione, inclusi segmenti compressi `.jsonl.zst` e subagent pertinenti senza double counting.
- [x] Nessuna indicizzazione globale nel flusso ordinario e nessun accumulo permanente al cambio di sessione.
- [x] Nessuna persistenza globale delle evidenze runtime (`0 B` su disco, stato in memoria giustificato dalle misurazioni).
- [x] Componenti di acquisizione (ADR-002), normalizzazione e riconciliazione preservati.
- [x] Riduzione netta del footprint computazionale verificata sui dati reali.
- [x] Zero nuove dipendenze; `npm run build`, `npm run typecheck`, `npm test` e `vsce package` superati.
- [x] ADR-003 aggiornato allo stato `Approved` e commit locale completato (`feat: implement session-centric data model (ADR-003)`).

## Questioni aperte

Nessuna.

## Esito della validazione

Validazione eseguita il 2026-11-24 su Windows (`Node.js v24.11.1`, `VS Code 1.147.0`, zero nuove dipendenze):

- **Build, typecheck, test e packaging:** `npm run build` (`exit 0`), `npm run typecheck` (`exit 0`), TypeScript `6.0.3` integrato in VS Code (`0` diagnostiche), `npm test` (`21/21 pass`, `432 ms`, incluse suite ADR-001/ADR-002 + `normalize.test.ts`, `reconcile.test.ts`, `session-monitor.test.ts`), `npm run package` (`16` file, `34,19 KB`).
- **Verifica su dati locali reali (sessione corrente per provider):**
  - **Codex (`reason: runtime_active`, `ambiguous: false`):** selezione `65 ms`, ricostruzione iniziale `405 ms` su `11` file (`54,1 MB`: sessione principale + segmenti/subagent), `7` sessioni (`1` principale + `6` subagent), `1.830` inferenze, `892` transizioni quota; aggiornamento incrementale `65 ms` (`0` file riletti, `11/11` saltati); memoria `RSS 86,0 MB` / `heapUsed 11,4 MB`.
  - **Claude Code (`reason: runtime_active`, `ambiguous: false`):** selezione `86 ms`, ricostruzione iniziale `2.150 ms` su `78` file (`185,7 MB`: mega-sessione principale + `38` subagent + `.meta.json` + `~/.claude.json`), `39` sessioni (`1` principale + `38` subagent), `5.819` inferenze, `7` snapshot quota; aggiornamento incrementale `102 ms` (`0` file riletti, `78/78` saltati); memoria cumulativa `RSS 234,3 MB` / `heapUsed 94,3 MB`.
  - **Storage su disco:** `0 B`.
- **Confronto rispetto al precedente scenario di indicizzazione globale** *(dovuto primariamente alla riduzione del carico di lavoro da `1.007` file storici a `89` file della sessione corrente, oltre alla rimozione della serializzazione JSON su disco)*:
  - File letti: `1.007` → **`89`** (`-91%`).
  - Tempo di inizializzazione totale (acquisizione + elaborazione/salvataggio): `~21,3 s` → **`~2,7 s`** (`-87%`).
  - Memoria di picco: `1.189,8 MB RSS` (`394,0 MB heap`) → **`234,3 MB RSS`** (`94,3 MB heap`, `-80% RSS`).
  - Storage su disco: `156,91 MB` (`76,92 MB` state + `79,99 MB` evidence) → **`0 B`**.
