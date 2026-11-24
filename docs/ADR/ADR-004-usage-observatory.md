# ADR-004 — Usage Observatory

- **Identificativo:** ADR-004
- **Data:** 2026-11-24
- **Stato:** Approved

## Contesto

ADR-001 (bootstrap estensione VS Code), ADR-002 (acquisizione passiva read-only per Codex e Claude Code, zero dipendenze runtime) e ADR-003 (modello dati canonico, normalizzazione, deduplicazione e stato in memoria session-centric tramite `ProviderSessionMonitor`) sono tutti nello stato `Approved` e costituiscono la baseline vincolante.

Questo ADR definisce il sottosistema **Usage Observatory**: l'integrazione del monitoraggio delle sessioni correnti di **Codex** e **Claude Code** nel ciclo di vita dell'estensione VS Code e il calcolo deterministico delle metriche necessarie a osservare consumi, evoluzione del contesto, burn rate recente e stato delle quote dell'abbonamento. Restano esplicitamente fuori perimetro: indicizzazione globale, persistenza su disco, classificazioni/soglie/alerting (ADR-005), Harness Auditor (ADR-006) e interfacce grafiche definitive come status bar, sidebar o webview (ADR-007).

### Verifica della baseline esistente

Dall'analisi diretta del codice implementato (`src/core/session-monitor.ts`, `src/core/model.ts`, `src/core/normalize.ts`, `src/core/reconcile.ts`, `src/acquisition/`, `src/providers/`, `src/extension.ts`) emergono:

- **Piena riutilizzabilità di `ProviderSessionMonitor`:** gestisce già selezione della sessione corrente, ricostruzione dei segmenti (inclusi `.jsonl.zst`) e dei soli subagent pertinenti, aggiornamento incrementale via `SourceCursorStore` e reset pulito dello stato al cambio di sessione preservando le quote provider-scoped.
- **Piena riutilizzabilità di `normalize.ts`, `model.ts` e `acquisition/`:** nessuna riprogettazione richiesta.
- **Quattro correzioni minimali necessarie ai componenti esistenti** (motivate direttamente dai requisiti di ADR-004, verificate su dati locali reali):
  1. **Seed del contesto incrementale in `reconcileObservations` (`src/core/reconcile.ts`):** `latestTurnModel` e `latestContextWindow` sono attualmente mappe `BatchScratch` create vuote a ogni chiamata; su un refresh incrementale Codex che legge un solo nuovo `token_usage_record` (senza un nuovo `turn_context`/`token_count` nello stesso batch), `model` e `contextWindow` della nuova inferenza risulterebbero `undefined`. Inizializzare le due mappe dallo stato già presente (`session.primaryModel`, ultimo `usageSnapshot.modelContextWindow` / ultima inferenza) risolve il problema in poche righe.
  2. **Distinzione dei veri user turn di Claude Code (`src/providers/claude/parser.ts`, `src/core/reconcile.ts`):** su un transcript reale di Claude Code (`6.702` record `type: "user"`), `6.310` sono `tool_result` (`toolUseResult !== undefined`), `58` sono `isMeta`, `18` sono `isCompactSummary` e `45` sono notifiche di sistema (`promptSource === 'system'` / `turnOrigin` in `task_notification`, `peer`, `system`), mentre solo `~270` sono reali turni utente. Attualmente `reconcile.ts` crea un `TurnRecord` per ogni record `user` e non associa le inferenze `assistant` (prive di `turnPromptId`, `0/11.390` localmente). Aggiungere il solo flag booleano `isToolResult` in `claude/parser.ts` (senza acquisire il contenuto di `toolUseResult`) e filtrare i `user` non umani in `reconcile.ts` rende accurati conteggio turni e inferenze/turno.
  3. **Inclusione del file `runtime_session` in `selectClaudeSession` (`src/core/session-monitor.ts`):** `ProviderSessionMonitor.refresh()` gestisce già `source.kind === 'runtime_session'`, ma il filtro `chosenSources` omette attualmente il file `sessions/<pid>.json` corrispondente alla sessione scelta. Includerlo espone stato e metadati runtime reali (`pid`, `status`, `statusUpdatedAt`).
  4. **Cache leggera del peek header e aggiornamento workspace in `ProviderSessionMonitor` (`src/core/session-monitor.ts`):** `selectCodexSession` apre fino a `40` file per leggerne la prima riga (`session_meta`) a ogni `refresh()`. Memorizzare `(path, mtimeMs, size) -> CodexHeaderMeta` in memoria (limitata ai candidati recenti) riduce il costo dei refresh periodici invariati a semplici `stat`; aggiungere l'aggiornamento del `workspace` consente inoltre di reagire al cambio di cartella in VS Code senza ricreare il monitor.

## Decisione

### 1. Architettura dell'Observatory

Due moduli core in `src/observatory/` più integrazione minimale in `src/extension.ts`, mantenendo zero nuove dipendenze runtime:

```text
src/
├── observatory/
│   ├── metrics.ts        (tipi snapshot e funzioni pure di calcolo metriche)
│   └── observatory.ts    (UsageObservatory: ciclo di vita, refresh, isolamento errori, listener)
└── extension.ts          (attivazione onStartupFinished, workspace, dispose, handle read-only)
test/
├── observatory-metrics.test.ts
└── observatory.test.ts
```

- **Nessuna duplicazione dello stato:** `ProviderSessionMonitor` rimane l'unico proprietario di `SentraState` e `SourceCursorStore`. Gli snapshot dell'Observatory espongono esclusivamente metriche derivate e riferimenti essenziali (`sessionId`, `candidates`, serie `context` sintetica), mai copie dei dizionari grezzi `inferences`/`turns`/`usageSnapshots`/`lifecycleEvents`.
- **Notifica minimale:** `UsageObservatory` espone `onDidUpdate(listener: (snapshot: ObservatorySnapshot) => void): () => void` tramite un semplice `Set` di callback. Nessun event bus, nessun framework reattivo, nessuno store esterno.
- **Indipendenza dei provider:** `UsageObservatory` istanzia due `ProviderSessionMonitor` indipendenti (`'codex'`, `'claude'`), ciascuno con il proprio lock di concorrenza e gestione errori isolata.

### 2. Contratto degli snapshot (`src/observatory/metrics.ts`)

```ts
export interface ObservatorySnapshot {
  updatedAtMs: number;
  workspace?: string;
  providers: Record<ProviderId, ProviderObservatorySnapshot>;
}
```

Ogni `ProviderObservatorySnapshot` è suddiviso in sezioni piatte e tipizzate:

#### A. Identità e stato (`identity`)

- `provider: ProviderId`
- `status: 'initializing' | 'active' | 'runtime_idle' | 'recent' | 'idle' | 'no_session' | 'unavailable' | 'error'`
- `activityEvidence: 'runtime_process' | 'recent_transcript' | 'historical_fallback' | 'none'`
- `runtimePresent: boolean` *(vero solo con evidenza di processo vivo verificata; distinto dall'attività agentica)*
- `sessionId?: string`, `nativeSessionId?: string`, `workspace?: string`
- `currentModel?: string`, `modelsObserved: string[]`
- `startedAtMs?: number`, `lastActivityAtMs?: number`
- `selectionReason: SelectionReason`, `ambiguous: boolean`, `candidateCount: number`, `candidates: SessionCandidate[]`
- `runtimePid?: number`, `runtimeStatus?: string` *(solo quando supportati da evidenze runtime verificate)*
- `lastError?: string` *(solo se `status === 'error'`, senza path sensibili né contenuti di log)*

**Regola sullo stato `active` vs processo runtime:** un PID vivo dimostra l'esistenza del processo (`runtimePresent: true`), non necessariamente un'esecuzione agentica in corso. Una sessione viene marcata `'active'` **esclusivamente** in presenza di evidenza runtime di processo **e** stato runtime esplicito di esecuzione (`running`/`busy`/`active`) oppure turno aperto/attività inferenziale recente; se il processo esiste ma risulta `idle` o senza attività osservata recente, lo stato è `'runtime_idle'`. Per Codex — privo di file PID runtime — un rollout non compresso modificato di recente viene riportato come `'recent'` (`runtimePresent: false`, `activityEvidence: 'recent_transcript'`), mai come `'active'` sulla sola base di `mtime`.

#### B. Copertura e compatibilità dei dati (`coverage`)

- `level: 'complete' | 'partial' | 'snapshot_only' | 'unavailable'`
- `sourceKind: 'inferences' | 'usage_snapshot' | 'both' | 'none'`
- `inferencesTotal`, `inferencesWithPartialTokens`, `inferencesWithConflicts`, `inferencesWithApiError`, `inferencesMissingTimestamp`
- `hasSnapshotDiscrepancy: boolean`
- `notes: string[]` *(codici espliciti di limitazione: `legacy_snapshot_only`, `partial_token_partition`, `context_window_unavailable`, `server_side_multi_iteration`, `snapshot_inference_discrepancy`, `no_runtime_process_evidence`, `conflicting_duplicate_inferences`)*

**Gestione compatibilità e regola su `complete`:**
- `coverage.level = 'complete'` viene assegnato **esclusivamente** quando la copertura è effettivamente verificabile (presenza di inferenze prive di contatori parziali/conflitti/timestamp mancanti **e** riscontro coerente con uno snapshot cumulativo dell'harness). L'assenza di discrepanze note in mancanza di riscontro verificabile produce `coverage.level = 'partial'` con nota `completeness_unverified`.
- I rollout Codex legacy privi di `token_usage_record` espongono i contatori cumulativi osservati in `usage.harnessSnapshot` con `coverage.level = 'snapshot_only'` e `direct.inferenceCount = 0`, senza mai inventare inferenze.
- I contatori cumulativi riportati dall'harness (`codex_token_count`, `claude_cost_state`) non vengono mai sommati alle inferenze ricostruite. Quando entrambi sono presenti e i totali divergono, la distinzione viene preservata e `hasSnapshotDiscrepancy: true` viene segnalato esplicitamente.

#### C. Consumo cumulativo (`usage`)

Struttura condivisa `TokenTotals`:

```ts
export interface TokenTotals {
  totalInputTokens?: number;
  uncachedInputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  outputTokens?: number;
  reasoningTokens?: number;
  totalTokens?: number;
  cacheHitRatio?: number;        // 0..1 su inferenze con cacheRead e totalInput definiti (totalInput > 0)
  inferenceCount: number;
  partialCount: number;          // inferenze con >=1 contatore atteso assente/partial
  isPartial: boolean;
}
```

- `direct: TokenTotals` — solo `primarySession.directInferenceIds` (escluse `inheritedInferenceIds` e subagent).
- `subagents: TokenTotals` — somma deduplicata dei `directInferenceIds` dei soli subagent figli (`isSubagent === true`) della sessione monitorata.
- `total: TokenTotals` — unione deduplicata per `InferenceRecord.id` di `direct` + `subagents` (double counting strutturalmente impossibile).
- `byModel: Record<string, TokenTotals>` — aggregazione per modello (`model ?? 'unknown'`) sull'insieme deduplicato `total` della sessione monitorata.
- `harnessSnapshot?: HarnessUsageSnapshot` — ultimo snapshot cumulativo riportato dall'harness (`codex_token_count` con `totalTokens`/`lastTokens`/`modelContextWindow`, o `claude_cost_state` con `totalCostUSD`/`modelUsage`), tenuto sempre separato dalle inferenze.

**Invarianti di aggregazione:**
- I valori mancanti restano `undefined` (mai sostituiti con `0`). Se un campo è assente su tutte le inferenze del gruppo rimane `undefined`; se è presente solo su un sottoinsieme viene aggregato sui record disponibili marcando `isPartial: true` e incrementando `partialCount`.
- I tre bucket dell'input (`uncachedInputTokens`, `cacheReadTokens`, `cacheWriteTokens`) rispettano la partizione disgiunta di ADR-003.
- `reasoningTokens` è preservato come sottoinsieme dell'output e non viene mai sommato nuovamente a `outputTokens` o `totalTokens`.

#### D. Comportamento agentico (`agentic`)

- `directInferenceCount: number`, `totalInferenceCount: number`
- `userTurnCount?: number` *(numero di user turn reali ricostruibili sulla sessione principale; `undefined` se non ricostruibili, es. `snapshot_only`)*
- `inferencesInLatestTurn?: number` *(inferenze dirette della sessione principale nell'ultimo user turn ricostruibile)*
- `avgInferencesPerTurn?: number` *(definito quando `userTurnCount > 0` e l'associazione turno-inferenza è ricostruibile)*
- `avgInputTokensPerInference?: number`, `maxInputTokensPerInference?: number` *(calcolati sulle inferenze dirette della sessione principale con `totalInputTokens` definito)*
- `subagentCount: number`
- `subagents: Array<{ sessionId, agentId?, agentType?, primaryModel?, modelsObserved, startedAtMs?, lastActivityAtMs?, tokens: TokenTotals }>`

Per Claude Code, dove le inferenze `assistant` non riportano `turnPromptId`, l'associazione al turno utente nella sessione principale avviene in modo deterministico per ordine temporale/catena di `parentUuid` rispetto ai `TurnRecord` reali filtrati; in assenza di user turn ricostruibili i campi basati sui turni restano `undefined`. Nessuna classificazione automatica di efficienza o produttività.

#### E. Context evolution (`context`)

Calcolata **esclusivamente** sulle inferenze dirette della sessione principale (mai subagent, mai input cumulativi):

- `series: ContextPoint[]` — ordinate cronologicamente per `timestampMs` (tie-break deterministico su posizione sorgente/`id`):
  - `inferenceId: string`, `timestampMs?: number`, `totalInputTokens?: number`, `cacheReadTokens?: number`, `model?: string`, `turnId?: string`, `cumulativeTotalTokens?: number`, `isAggregatedServerSide?: boolean`.
- `compactions: CompactionMarker[]` — eventi `kind === 'compaction'` della sessione principale con `eventId`, `timestampMs`, `afterInferenceIndex` (indice nella serie `series` che colloca la compaction rispetto alle inferenze) e metadati sintetici già estratti (`preTokens`, `postTokens`, `trigger`, `windowNumber`).
- `currentContextTokens?: number` — `totalInputTokens` dell'ultima inferenza pertinente non aggregata della sessione principale.
- `currentContextTimestampMs?: number` — timestamp originale dell'inferenza da cui deriva `currentContextTokens`.
- `isCurrentContextFromLatestInference: boolean` — `false` se l'ultima inferenza della serie non fornisce una misura valida di singolo contesto (es. multi-iterazione server-side o contatore mancante), così da non presentare una misura precedente come corrente senza contesto temporale esplicito.
- `contextWindowTokens?: number` — popolato **solo** quando osservato nei log del provider (es. Codex `model_context_window` / `session_meta.context_window`). Per Claude Code resta `undefined`; **nessuna mappa statica delle context window**.
- `contextOccupancyPercent?: number` — `(currentContextTokens / contextWindowTokens) * 100` solo quando entrambi sono definiti e `contextWindowTokens > 0`.

**Contatori aggregati server-side:** se `nativeUsage.iterations` (Claude Code) contiene più di un'iterazione (`iterations.length > 1`), i contatori top-level aggregano più chiamate server-side e **non** rappresentano la dimensione di un singolo contesto; il punto viene marcato `isAggregatedServerSide: true`, omette `totalInputTokens` dalla serie di contesto, non sovrascrive `currentContextTokens` con la somma aggregata e aggiunge la nota `server_side_multi_iteration` in `coverage.notes`. Nessun campionamento grafico (demandato ad ADR-007).

#### F. Burn rate (`burnRate`)

Finestra mobile fissa di **5 minuti** (`windowMs = 300_000`) calcolata da funzione pura con riferimento temporale controllabile `nowMs` (`(nowMs - windowMs, nowMs]`):

- `windowMinutes: 5`, `evaluatedAtMs: number`, `scope: 'session_total'` *(inferenze deduplicate della sessione monitorata inclusi subagent)*
- `inputTokensPerMin?: number`
- `cacheReadTokensPerMin?: number`
- `cacheWriteTokensPerMin?: number` *(definito solo se `cacheWriteTokens` è osservato nella finestra o nella sessione; `undefined` se non disponibile)*
- `outputTokensPerMin?: number`
- `inferencesPerMin?: number` *(valorizzato a `0` solo in caso di inattività osservata con copertura valida; `undefined` quando `windowCoverage === 'unavailable'`)*
- `inferencesInWindow: number`
- `windowCoverage: 'full' | 'partial' | 'unavailable'` *(marcata `'partial'` se la sessione ha durata osservata `< 5 min`, o se inferenze pertinenti mancano di timestamp o di contatori; `'unavailable'` se `snapshot_only`/nessuna inferenza con timestamp — in tal caso tutti i rate restano `undefined`, mai `0`)*
- `missingTimestampCount: number`

**Semantica di decadimento:** il denominatore è sempre la finestra coerente di `5` minuti e il filtro usa esclusivamente i **timestamp originali delle inferenze deduplicate** (mai il timestamp di lettura di Sentra). Durante l'inattività, al trascorrere di `nowMs`, le inferenze escono dalla finestra e il burn rate decade deterministicamente verso `0` anche senza nuovi eventi nei log. Nessuna soglia, anomalia, notifica o stima ETA.

#### G. Subscription usage (`subscription`)

Oggetto separato dalle metriche di sessione con `scope: 'provider_account'`:

- `provider: ProviderId`, `scope: 'provider_account'`, `freshness: 'observed' | 'cached' | 'stale' | 'expired_reset' | 'unavailable'`
- **Codex:** lista `categories` (una per `categoryKey` distinto, es. `codex:codex`), ciascuna con `limitId`, `limitName`, `planType`, `windows[]` (`windowId`, `usedPercent`, `remainingPercent` derivata come `100 - usedPercent` se in `[0, 100]`, `windowMinutes`, `resetsAtMs` normalizzato da secondi Unix a ms, `lastObservedAtMs`, `ageMs`, `resetPassedWithoutNewObservation`), flag di stato opzionali (`spendControlReached`, `rateLimitReachedType`) e `recentTrend` (ultime transizioni compresse da `state.quotaSnapshots`, es. fino a `50` punti).
- **Claude Code:**
  - `cached`: dati da `~/.claude.json` (`cachedUsageUtilization`) con `isCached: true`, `fetchedAtMs` originale (mai `mtime` del file), `ageMs = nowMs - fetchedAtMs`, `isStale: boolean`, finestre osservate separate (`five_hour`, `seven_day`, `seven_day_opus`, `seven_day_sonnet`, elementi di `limits[]` con `kind`/`group`/`percent`/`severity`/`resets_at`/`scope`, sintesi `spend`/`extra_usage` se presente) e `resetPassedWithoutNewObservation` per ogni finestra.
  - `rateLimitStatus`: ultimo evento `quotaLimits` osservato nei transcript (`status`, `rateLimitType`, `resetsAtMs`, `overageStatus`, `isUsingOverage`, `lastObservedAtMs`, `ageMs`, `resetPassedWithoutNewObservation`).

**Invarianti comuni:** nessuna deduzione della quota dai token elaborati; nessuna attribuzione delle variazioni alla sessione corrente; nessun azzeramento artificiale al superamento di `resetsAtMs` senza nuova osservazione (`resetPassedWithoutNewObservation: true` + `freshness: 'expired_reset'`); nessuna chiamata cloud, lettura credenziali o modifica di configurazioni.

### 3. Ciclo di vita VS Code e strategia di refresh

- **Attivazione (`package.json`):** `activationEvents: ["onStartupFinished"]`. Il comando `sentra.verifyInstallation` rimane invariato; nessun contributo UI definitivo (nessuna status bar, sidebar o webview).
- **Inizializzazione non bloccante (`src/extension.ts`):** `activate(context)` registra `sentra.verifyInstallation`, determina il workspace attivo (`vscode.workspace.workspaceFolders?.[0]?.uri.fsPath`), crea `UsageObservatory`, registra il teardown in `context.subscriptions` e il listener `vscode.workspace.onDidChangeWorkspaceFolders`, quindi avvia `observatory.start()` in modo asincrono senza `await` bloccante su `activate()`.
- **Meccanismo singolo di refresh:** un unico timer periodico (`setInterval`, default **`3.000 ms`**, `unref()`, configurabile nei test) esegue il refresh indipendente di `'codex'` e `'claude'`.
  - **Concorrenza:** ciascun provider mantiene una promise `inFlight`; un tick che arriva mentre un refresh dello stesso provider è ancora in corso viene saltato senza sovrapposizioni, mentre l'altro provider procede normalmente.
  - **Inattività e decadimento:** anche quando `filesRead === 0` e `switched === false`, il tick ricalcola le metriche dipendenti dal tempo (`burnRate`, `ageMs`/`freshness` delle quote) rispetto a `nowMs` e notifica i listener solo quando lo snapshot cambia effettivamente (nuovi eventi, cambio sessione, variazione di `burnRate` o cambio di stato/stale delle quote), evitando notifiche ridondanti.
  - **Nessuna scansione storica:** ogni tick opera solo su `ProviderSessionMonitor.refresh()` (`mode: 'incremental'`, con cache `(path, mtimeMs, size)` per il peek degli header Codex e skip totale dei file invariati tramite `SourceCursorStore`).
  - **Rilascio risorse:** `dispose()` ferma il timer, marca l'istanza come chiusa (scartando eventuali refresh in volo al completamento) e svuota i listener. `deactivate()` garantisce il cleanup anche qualora invocato esplicitamente.
- **Esposizione read-only per validazione:** `activate()` restituisce un handle minimale in sola lettura (`{ getSnapshot, getProviderSnapshot, onDidUpdate, refresh }`) ispezionabile dallo smoke test nell'Extension Development Host e dai futuri consumatori (ADR-005/007) senza introdurre comandi debug o UI temporanee.

### 4. Strategia di testing e validazione

Stack invariato (`node:test` + `node:assert/strict`, zero nuove dipendenze):

- **Unit test sulle metriche (`test/observatory-metrics.test.ts`):**
  - Consumo diretto, subagent e totale inclusivo senza double counting (Codex e Claude Code), breakdown per modello.
  - Partizione disgiunta dei token, reasoning mai risommato all'output, preservazione `undefined` vs `0`, copertura parziale esplicita.
  - Rollout Codex legacy (`snapshot_only`, zero inferenze inventate) e rilevazione discrepanza tra inferenze e snapshot cumulativi.
  - Context evolution sulla sola sessione principale (subagent esclusi), posizionamento compaction, gestione `iterations.length > 1` server-side, occupazione % Codex su `contextWindow` osservata, assenza di mappa statica per Claude.
  - Burn rate su finestra 5 minuti con `nowMs` controllato: calcolo da timestamp originali, decadimento verso `0` in inattività senza nuovi log, copertura parziale sotto i 5 minuti.
  - Quote separate dalla sessione, categorie Codex distinte + trend recente, quota Claude cached con età/staleness e mancato azzeramento oltre `resetsAtMs`.
- **Integration test dell'Observatory (`test/observatory.test.ts`):**
  - Cambio di sessione monitorata (nessun mescolamento dei consumi, reset stato precedente, preservazione quote).
  - Prevenzione refresh concorrenti sullo stesso provider e indipendenza tra provider.
  - Indisponibilità o errore di un provider senza impatto sull'altro.
  - Aggiornamento del burn rate durante l'inattività su tick successivi.
  - Rilascio completo di timer e listener su `dispose()`.
- **Smoke test nell'Extension Development Host:** avvio di VS Code con `--extensionDevelopmentPath` verificando attivazione `onStartupFinished`, validità dello snapshot restituito dall'handle esportato, persistenza del comando `sentra.verifyInstallation` e disattivazione pulita.
- **Verifica read-only su dati reali (`~/.codex` e `~/.claude`):** misurazione una tantum (senza framework di benchmark permanente) di tempo di inizializzazione, latenza di aggiornamento dopo nuova inferenza, durata del refresh in assenza di nuovi eventi, memoria (`RSS`/`heapUsed`) e stabilità della memoria su cicli ripetuti di refresh e cambi sessione, confrontati con la baseline di ADR-003 (`405 ms` Codex, `2.150 ms` Claude, `234,3 MB RSS` combinati).

## Motivazioni

- **Semplicità e assenza di duplicazione (Ponytail):** funzioni pure in `metrics.ts` e un unico orchestratore in `observatory.ts` riusano integralmente `ProviderSessionMonitor` e `SentraState` senza livelli intermedi, event bus o copie dello stato.
- **Unico meccanismo di refresh a timer (`3 s`) con cache header:** risolve simultaneamente l'aggiornamento incrementale, il decadimento deterministico del burn rate durante l'inattività, l'aggiornamento dell'età delle quote e la scoperta di nuove directory dinamiche (rollout giornalieri Codex `YYYY/MM/DD`, nuove directory `subagents/` Claude) evitando duplicazione tra `fs.watch` e timer e le criticità di `fs.watch` su Windows.
- **Fedeltà semantica sui dati reali:** l'ispezione della baseline ha prevenuto errori concreti prima dell'implementazione (falso stato `active` su Codex, `tool_result` contati come user turn su Claude, perdita di `model`/`contextWindow` su refresh incrementali Codex, aggregazione multi-iterazione server-side su Claude).

## Alternative rilevanti

1. **Combinazione `IncrementalWatcher` (`fs.watch`) + timer periodico:** offre latenza sub-secondo sugli append al file corrente, ma introduce due meccanismi concorrenti, gestione dinamica di watch handle al cambio sessione/data/subagent su Windows e richiede comunque un timer per il decadimento del burn rate e la scoperta di nuove sessioni. `src/acquisition/watcher.ts` resta comunque disponibile e intatto qualora misurazioni future rendessero necessaria una latenza inferiore a `3 s`.
2. **Denominatore dinamico `min(5 min, età sessione)` per il burn rate:** produce picchi artificiali molto elevati nei primi secondi di una sessione; mantenere sempre il denominatore coerente di `5` minuti con `windowCoverage: 'partial'` garantisce stabilità e monotonicità.
3. **Comando VS Code temporaneo (es. `sentra.dumpObservatory`) per lo smoke test:** inquinerebbe la Command Palette e `package.json`; restituire un handle read-only da `activate()` mantiene `package.json` pulito e prepara il contratto interno per ADR-005/007.

## Conseguenze e limitazioni

- Latenza massima di aggiornamento pari all'intervallo di polling configurato (default `3 s`), verificata in fase di implementazione rispetto al budget CPU/IO dei refresh idle.
- Su Codex, in assenza di evidenze runtime di processo (PID), lo stato massimo osservabile è `'recent'` (non `'active'`).
- Su Claude Code, la quota da `~/.claude.json` (`cachedUsageUtilization`) può avere un'età arbitrariamente elevata (es. osservata a `262 h` sull'ambiente locale) e rimane esplicitamente marcata come cached/stale; la context window non è riportata in percentuale in assenza di capacità verificabile.
- Le quattro correzioni minimali ai moduli di ADR-002/003 (`claude/parser.ts`, `reconcile.ts`, `session-monitor.ts`) verranno applicate in fase di implementazione preservando integralmente tutti i test esistenti.

## Criteri di accettazione

### Fase corrente — Proposta

- [x] Baseline di ADR-001, ADR-002 e ADR-003 verificata sul codice reale.
- [x] Perimetro session-centric rispettato (nessuna indicizzazione globale né persistenza).
- [x] Metriche, semantiche e gestione dei dati mancanti/parziali/obsoleti definite.
- [x] Contratto degli snapshot definito senza duplicazione di `SentraState`.
- [x] Strategia di refresh e integrazione lifecycle VS Code definite.
- [x] Strategia di testing, smoke test e verifica read-only proporzionata definita.
- [x] Deviazioni e questioni aperte motivate.
- [x] ADR salvato in `docs/ADR/ADR-004-usage-observatory.md` con stato `Proposed`.

### Fase successiva — Implementazione

- [x] Correzioni minimali di baseline applicate senza regressioni su ADR-001/002/003.
- [x] Observatory funzionante per Codex e Claude Code con monitoraggio automatico su `onStartupFinished`.
- [x] Metriche complete, accurate e aggiornate incrementalmente (dirette, subagent, totali, agentic, context evolution, burn rate con decadimento, subscription usage separata).
- [x] Gestione esplicita di dati mancanti, parziali, `snapshot_only`, ambigui e quote stale/scadute.
- [x] Zero indicizzazione globale, zero persistenza su disco, nessuna crescita incontrollata di memoria su refresh ripetuti e cambi sessione.
- [x] Zero nuove dipendenze runtime.
- [x] `npm run build`, `npm run typecheck`, verifica TS `6.0.3`, `npm test`, `vsce package`, smoke test Extension Host e verifica read-only su dati reali superati.
- [x] ADR aggiornato ad `Approved` e commit locale circoscritto.

## Questioni aperte

Nessuna. Tutte le decisioni sono state approvate, implementate e verificate:

1. **Meccanismo unico di refresh:** singolo timer periodico da `3.000 ms` con cache in memoria `(mtimeMs, size, ino)` degli header Codex e lock per provider; `IncrementalWatcher` escluso dal flusso ordinario dell'Observatory; durante i refresh invariati vengono aggiornate le sole metriche dipendenti dal tempo senza ricostruire aggregazioni o serie temporali né emettere notifiche ridondanti.
2. **Staleness quota Claude e scope burn rate:** soglia informativa di `15 minuti` per `cachedUsageUtilization` (preservando sempre `fetchedAtMs` originale e distinguendo valore cached da valore verificato in tempo reale); burn rate su finestra mobile di `5 minuti` con scope `session_total` (principale + subagent deduplicati), `undefined` se non calcolabile e decadimento a `0` durante l'inattività osservata.
3. **Handle read-only esportato da `activate()`:** oggetto minimale `{ getSnapshot, getProviderSnapshot, onDidUpdate, refresh }` privo di accesso diretto allo stato interno, senza API pubblica versionata né comandi temporanei in `package.json`.
4. **Correzioni baseline:** applicate le quattro correzioni minimali approvate (`latestTurnModel`/`latestContextWindow`, filtro user turn reali Claude, inclusione `runtime_session` Claude, cache header Codex e aggiornamento workspace) più la correzione emersa in revisione sull'attribuzione dei `token_usage_record` dei subagent Codex.

## Esito della revisione e validazione

Validazione eseguita il 2026-11-24 su Windows (`Node.js v24.11.1`, `VS Code 1.147.0`, zero nuove dipendenze):

- **Revisione tecnica (problemi individuati e corretti):**
  - *[Alta — individuato su dati reali]* Subagent Codex: `token_usage_record` nei rollout subagent usa `payload.session_id` del padre e `payload.thread_id` del subagent; `src/providers/codex/parser.ts` e `src/core/session-monitor.ts` ora preservano l'identità del subagent sia a freddo sia su append incrementali (`1.444` inferenze dirette + `408` di `6` subagent = `1.852` totali sul dataset reale, senza inquinare il contesto principale).
  - *[Media]* Cambio workspace durante refresh in volo (`src/observatory/observatory.ts`): eliminato `rerunPending` staccato e gestito il rerun nello stesso ciclo `inFlight` così che `await handle.refresh()` risolva sempre sullo snapshot del workspace più recente.
  - *[Media]* Tick idle con `missingTimestampCount > 0` (`src/observatory/metrics.ts`): evitata la riscansione delle inferenze in `updateTimeDependentMetrics` quando `inferencesInWindow === 0` e la finestra breve di 5 minuti è già trascorsa; segnalata `windowPartialTokens` anche per campi cache misti nella finestra.
  - *[Media]* Transizione da sessione a `no_session` (`src/core/session-monitor.ts`): azzeramento pulito dello stato di sessione precedente quando tutte le fonti spariscono; inclusione di `claude_json_usage` anche senza transcript Claude così le quote account restano osservabili.
  - *[Bassa]* Ottimizzazione two-pointer $O(N + T)$ in `resolveTurnAssignments`, selezione dell'evento `runtime_session` più recente per timestamp e redazione dei percorsi UNC Windows in `sanitizeErrorMessage`.
- **Build, typecheck, test e packaging:** `npm run build` (`exit 0`), `npm run typecheck` (`exit 0`), TypeScript `6.0.3` integrato in VS Code (`0` diagnostiche), `npm test` (`26/26 pass`, `453 ms`), `npm run package` (`18` file, `48,21 KB`, zero dipendenze runtime).
- **Smoke test Extension Development Host:** attivazione automatica confermata su `onStartupFinished` (`autoActivated: true`), avvio non bloccante (`initialStatuses: initializing`), handle esportato strettamente read-only (`getSnapshot`, `getProviderSnapshot`, `onDidUpdate`, `refresh`), `2` notifiche di aggiornamento, snapshot popolati per entrambi i provider, comando `sentra.verifyInstallation` registrato ed eseguito, `deactivate()` disponibile (`EXIT_CODE=0`).
- **Validazione prestazionale read-only su dati reali (confronto con baseline ADR-003):**
  - **Inizializzazione:** Codex `422,8 ms` *(baseline `405 ms`)*, Claude Code mega-sessione `185,7 MB` / `78` file `2.176,1 ms` *(baseline `2.150 ms`)*, complessiva `2.599 ms` *(baseline `~2,7 s`)*.
  - **Refresh idle (10 iterazioni consecutive, `0` file riletti, `0` notifiche ridondanti, riferimenti `usage`/`context` preservati):** Codex media `48,1 ms` (max `51,2 ms`), Claude media `107,4 ms` (max `115,3 ms`), combinato `155,5 ms` (~5,2% del periodo da `3.000 ms`).
  - **Latenza incrementale (fixture controllata, 10 append):** media `7,5 ms` (max `8,3 ms`); 10 cambi sessione alternati senza accumulo di stato (`finalInferenceCount: 50`).
  - **Memoria & storage:** picco iniziale combinato `234,8 MB RSS` / `97,3 MB heap` *(baseline `234,3 MB RSS`)*; steady state post-GC su 20 tick idle `22,6 MB → 22,9 MB heap` (nessun leak); storage persistente su disco `0 B`.
