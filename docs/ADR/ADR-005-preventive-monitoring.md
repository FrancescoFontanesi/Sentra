# ADR-005 — Preventive Monitoring

- **Identificativo:** ADR-005
- **Data:** 2026-11-24
- **Stato:** Approved

## Contesto

ADR-001 (bootstrap estensione VS Code), ADR-002 (acquisizione passiva read-only), ADR-003 (modello dati canonico e stato in memoria session-centric) e ADR-004 (Usage Observatory integrato su `onStartupFinished` con timer unico da `3.000 ms`, metriche deterministiche e handle read-only) sono tutti `Approved` e costituiscono la baseline vincolante.

Questo ADR definisce il sottosistema **Preventive Monitoring**: un livello deterministico e privo di persistenza che valuta gli snapshot pubblicati dall'Usage Observatory per evidenziare sei condizioni misurabili che meritano l'attenzione dell'utente durante l'uso corrente di **Codex** e **Claude Code**. Il sottosistema non giudica l'utilità del lavoro dell'agente, non introduce efficiency score, non legge direttamente i transcript, non introduce nuovi timer/watcher e non implementa notifiche UI, toast, dashboard o componenti dell'Harness Auditor (demandati ad ADR-006/ADR-007).

### Verifica della baseline ADR-004

Dall'esame di `src/observatory/metrics.ts`, `src/observatory/observatory.ts`, `src/core/model.ts`, `src/core/session-monitor.ts` e `src/extension.ts`:

- **Cinque indicatori su sei** (`Context Pressure`, `Context Growth`, `Repeated Context Processing`, `Agentic Intensity`, `Quota Pressure`) sono valutabili **integralmente** sugli snapshot già esposti da `ProviderObservatorySnapshot` senza modifiche all'Observatory.
- **Un solo gap circoscritto** riguarda `Consumption Acceleration`: `BurnRateMetrics` calcola attualmente solo la finestra corrente di 5 minuti `(nowMs - 5m, nowMs]` e non espone la finestra precedente non sovrapposta `(nowMs - 10m, nowMs - 5m]` sullo stesso scope `session_total` (inclusivo dei subagent). Poiché `computeBurnRate()` scorre già l'elenco delle inferenze deduplicate con timestamp, estendere `BurnRateMetrics` con un campo opzionale `previousWindow` calcolato nel medesimo passaggio risolve il requisito senza duplicare collezioni, senza nuove letture e con costo trascurabile.
- **Riferimento empirico circoscritto (sole due sessioni correnti reali, zero indicizzazione storica):**
  - *Codex (`1.453` punti principali, `60` turni):* contesto corrente `230.863 / 475.000` (`48,6%`), inferenze/turno `p50 = 15`, `p90 = 59`, `max = 127`; crescita su 5 inferenze confrontabili `>= +40k` e `>= +40%` in soli `6` casi su `1.453` (`0,4%`); picco cache-read 5 min `8,29 M` (`54,7×` contesto); picco accelerazione 5 min `16,54×`.
  - *Claude Code (`4.835` punti principali, `242` turni):* contesto corrente `570.272` (`contextWindow` assente), inferenze/turno `p50 = 10`, `p90 = 52`, `max = 139`; crescita su 5 inferenze confrontabili `>= +40k` e `>= +40%` in `5` casi su `4.835` (`0,1%`, max `+116.818` / `+127%`); picco cache-read 5 min `17,61 M` (`31,7×` contesto); picco accelerazione 5 min `10,7×`.

## Decisione

### 1. Estensione minimale all'Observatory (`src/observatory/metrics.ts`)

`BurnRateMetrics` aggiunge un singolo riepilogo opzionale della finestra precedente non sovrapposta `(nowMs - 10m, nowMs - 5m]`, calcolato nello stesso loop di `computeBurnRate()`:

```ts
export interface BurnRateWindowSummary {
  inputTokensPerMin?: number;
  outputTokensPerMin?: number;
  inferencesPerMin?: number;
  inferencesInWindow: number;
  windowCoverage: 'full' | 'partial' | 'unavailable';
}
```

- `AgenticMetrics` espone inoltre `latestTurnId?: string` e `latestTurnStatus?: 'started' | 'completed' | 'aborted'` (già presenti in `TurnRecord`) per distinguere il turn corrente da un turn completato/precedente e rivalutare immediatamente al cambio turn.
- `updateTimeDependentMetrics` ricalcola il burn rate finché `inferencesInWindow > 0` oppure `(previousWindow?.inferencesInWindow ?? 0) > 0` (o al completamento delle finestre iniziali di 5/10 minuti), garantendo il decadimento di entrambe le finestre durante l'inattività e restando $O(1)$ a regime.
- `snapshotChangeSignature` include lo stato sintetico di `previousWindow`, `latestTurnId`/`latestTurnStatus`/`inferencesInLatestTurn` e il superamento della soglia di freschezza di `15 min` anche per le finestre quota Codex, così che l'Observatory pubblichi gli aggiornamenti temporali necessari a `PreventiveMonitor` anche in assenza di nuove inferenze.

### 2. I sei indicatori preventivi (`src/monitoring/rules.ts`)

Tutte le soglie sono centralizzate in un oggetto `MONITORING_THRESHOLDS` (nessun DSL, nessun framework di regole, nessun sistema di configurazione utente in ADR-005).

#### 1. `context_pressure` (Scope: `session`)

- **Metriche:** `context.currentContextTokens`, `context.contextWindowTokens`, `context.contextOccupancyPercent`, `context.isCurrentContextFromLatestInference`, `context.currentContextTimestampMs`.
- **Requisiti di copertura:** `contextWindowTokens > 0`, `currentContextTokens !== undefined` e `isCurrentContextFromLatestInference === true`. Se uno manca (incluso Claude Code, per il quale non esiste alcuna mappa statica delle context window) → `not_evaluable`.
- **Attivazione:** Warning `>= 80%`; Critical `>= 90%`.
- **Risoluzione (isteresi `-5 pp`):** Critical scende a Warning se `< 85%`; Warning si risolve se `< 75%` (es. dopo compaction).
- **Motivazione soglie:** baseline richiesta da ADR-005; `-5 pp` evita oscillazioni ripetute attorno a `80%`/`90%`.
- **Falsi positivi noti:** sessioni lunghe intenzionalmente prossime alla compaction automatica dell'harness.
- **Informazioni esposte:** occupazione `%`, token correnti, capacità osservata, timestamp dell'ultima inferenza.

#### 2. `context_growth` (Scope: `session`)

- **Metriche:** coda confrontabile di `context.series` (`totalInputTokens`, `model`, `isAggregatedServerSide`, `timestampMs`) e `context.compactions` (`afterInferenceIndex`).
- **Segmento confrontabile (selezione deterministica senza scelta opportunistica):** si percorre a ritroso dall'ultimo punto della serie fino a un massimo di `5` inferenze consecutive della sessione principale, interrompendo il segmento alla prima compaction intermedia, cambio di modello, `totalInputTokens === undefined` o `isAggregatedServerSide === true`. Viene valutato **esclusivamente** tale suffisso massimale confrontabile (lunghezza `3`, `4` o `5`), senza mai cercare sotto-finestre che massimizzino l'incremento.
- **Requisiti di copertura:** ultimo punto valido e segmento confrontabile di almeno `3` inferenze (fino a `5`) con punto iniziale `> 0`. Altrimenti (es. subito dopo compaction o cambio modello) → `not_evaluable`.
- **Attivazione / escalation:** Warning `deltaAbs >= 40.000` token **e** `deltaRel >= 40%`; Critical `deltaAbs >= 80.000` token **e** `deltaRel >= 75%`.
- **De-escalation (Critical → Warning):** `deltaAbs < 65.000` **oppure** `deltaRel < 60%`.
- **Risoluzione (isteresi):** su un segmento confrontabile valido (`>= 3` punti), `deltaAbs < 25.000` **oppure** `deltaRel < 25%`.
- **Motivazione soglie:** la doppia condizione assoluta + relativa impedisce segnalazioni su contesti piccoli (es. `2k → 10k`); sulle due sessioni reali seleziona solo i picchi anomali (`0,1%–0,4%` degli step).
- **Falsi positivi noti:** lettura intenzionale di file molto estesi o output di test/log voluminosi in un singolo step legittimo.
- **Informazioni esposte:** `deltaAbs`, `deltaRel`, contesto iniziale/finale del segmento, numero di inferenze confrontate, modello.

#### 3. `repeated_context_processing` (Scope: `session`)

- **Metriche:** `burnRate.cacheReadTokensPerMin`, `burnRate.inputTokensPerMin`, `burnRate.inferencesInWindow`, `burnRate.windowCoverage`, `context.currentContextTokens`, `context.isCurrentContextFromLatestInference`.
- **Valori derivati (finestra recente 5 min, inferenze deduplicate):** `recentCacheRead = cacheReadTokensPerMin * 5`, `recentInput = inputTokensPerMin * 5`, `cacheReadShare = recentCacheRead / recentInput`.
- **Coerenza dello scope sul multiplo del contesto:** poiché `burnRate` include eventuali subagent (`session_total`) mentre `currentContextTokens` è riferito alla sola sessione principale, `contextMultiple = recentCacheRead / currentContextTokens` viene calcolato **esclusivamente** quando `usage.subagents.inferenceCount === 0` e `currentContextTokens > 0` con `isCurrentContextFromLatestInference === true`. In presenza di subagent o contesto principale non valido, il multiplo è dichiarato esplicitamente non disponibile (`contextMultipleAvailable: false`) e si applica la semantica condizionale sui soli volume assoluto e share relativo, senza introdurre nuove aggregazioni complesse.
- **Requisiti di copertura:** `burnRate.windowCoverage !== 'unavailable'`, `cacheReadTokensPerMin !== undefined`, `inputTokensPerMin !== undefined`. Se `recentInput === 0` durante inattività osservata → `resolved`; se i contatori mancano → `not_evaluable`.
- **Attivazione / escalation:**
  - Warning: `recentCacheRead >= 2.000.000` token **e** `cacheReadShare >= 0,70` (e, solo quando `contextMultiple` è coerente e disponibile, `contextMultiple >= 10×`).
  - Critical: `recentCacheRead >= 5.000.000` token **e** `cacheReadShare >= 0,80` (e, solo quando `contextMultiple` è coerente e disponibile, `contextMultiple >= 20×`).
- **De-escalation (Critical → Warning):** `recentCacheRead < 4.000.000` **oppure** `cacheReadShare < 0,75` (oppure `contextMultiple < 16×` quando disponibile).
- **Risoluzione (isteresi):** `recentCacheRead < 1.500.000` **oppure** `cacheReadShare < 0,60` (oppure `contextMultiple < 8×` quando disponibile).
- **Motivazione soglie:** usa la finestra recente da 5 min invece del totale di vita della sessione così da risolversi al termine delle raffiche; calibrata rispetto ai picchi reali (`8,3M–17,6M` in 5 min / `31×–55×`).
- **Falsi positivi noti:** sequenze legittime di molti step rapidi su un contesto ampio che sfruttano correttamente il prompt caching; un cache-read elevato non dimostra contenuto identico, inutile o costo/quota proporzionale.
- **Informazioni esposte:** token cache-read elaborati negli ultimi 5 min, quota `%` sull'input recente, multiplo rispetto al contesto osservato (se disponibile), numero inferenze nella finestra.

#### 4. `agentic_intensity` (Scope: `session`)

- **Metriche:** `agentic.userTurnCount`, `agentic.inferencesInLatestTurn`, `agentic.latestTurnId`, `agentic.latestTurnStatus`, `agentic.subagentCount`.
- **Distinzione sessione/subagent e turn corrente/completato:** valuta **esclusivamente** le inferenze dirette della sessione principale associate all'ultimo user turn reale ricostruito da ADR-004 (`inferencesInLatestTurn`), distinguendo tramite `latestTurnStatus` il turn in corso (`started`) da un turn completato/interrotto (`completed`/`aborted`) o ultimo osservato. Le inferenze dei subagent non sono sommate al turn perché i transcript locali non forniscono un legame verificabile `subagent → userTurn`; `subagentCount` è incluso separatamente nelle sole evidenze informative. Al cambio di `latestTurnId`, la condizione viene rivalutata da zero anche con `0` inferenze nel nuovo turn, senza mai attribuire al nuovo turn una segnalazione del turn precedente.
- **Requisiti di copertura:** `userTurnCount !== undefined && inferencesInLatestTurn !== undefined`. Altrimenti (es. `snapshot_only`) → `not_evaluable`.
- **Attivazione / escalation:** Warning `>= 30` inferenze; Critical `>= 60` inferenze.
- **De-escalation (Critical → Warning):** `< 50` inferenze (sul medesimo turn).
- **Risoluzione (isteresi):** `inferencesInLatestTurn < 25` oppure cambio di `latestTurnId` verso un nuovo turn sotto soglia.
- **Motivazione soglie:** sulle sessioni reali osservate la mediana è `10–15` inferenze/turno e il `p90` è `52–59`; soglie `30 / 60` evitano rumore sui turni ordinari segnalando i turni particolarmente estesi.
- **Falsi positivi noti:** refactoring ampi, esecuzione di suite di test multi-step o task complessi deliberatamente delegati in un unico prompt.
- **Informazioni esposte:** inferenze dirette nel turn corrente, numero di turn utente nella sessione, numero di subagent associati alla sessione (separati).

#### 5. `consumption_acceleration` (Scope: `session`)

- **Metriche:** `burnRate.inputTokensPerMin`, `burnRate.inferencesInWindow`, `burnRate.windowCoverage` e `burnRate.previousWindow` (`inputTokensPerMin`, `inferencesInWindow`, `windowCoverage`).
- **Requisiti di copertura e baseline anti-ripresa:** valutabile **solo** se entrambe le finestre non sono `unavailable`, `previousWindow.inferencesInWindow >= 2`, `previousWindow.inputTokensPerMin >= 20.000` tok/min (`>= 100.000` input token nei 5 min precedenti) e `burnRate.inputTokensPerMin !== undefined`. Se la finestra precedente è vuota o sotto baseline (es. cold start o ripresa dopo inattività) → `not_evaluable` (`insufficient_baseline_activity`), evitando di classificare una normale ripresa come accelerazione.
- **Attivazione / escalation (con `curInfs >= 3`):**
  - `ratio = curInputPerMin / prevInputPerMin`, `absDeltaPerMin = curInputPerMin - prevInputPerMin`.
  - Warning: `ratio >= 2,5×` **e** `absDeltaPerMin >= 100.000` tok/min.
  - Critical: `ratio >= 4,0×` **e** `absDeltaPerMin >= 250.000` tok/min.
- **De-escalation (Critical → Warning):** `curInfs < 3` **oppure** `ratio < 3,2×` **oppure** `absDeltaPerMin < 180.000` tok/min.
- **Risoluzione (isteresi):** con baseline valida, `curInfs < 2` **oppure** `ratio < 1,8×` **oppure** `absDeltaPerMin < 60.000` tok/min (include il decadimento osservato a `0` tok/min durante l'inattività mentre la finestra precedente resta popolata).
- **Motivazione soglie:** il requisito minimo su `prevInfs` (`>= 2`), `prevInputPerMin` (`>= 20k/min`) e delta assoluto (`+100k/min`) elimina divisioni per zero e picchi su baseline trascurabili.
- **Falsi positivi noti:** avvio legittimo di subagent paralleli o passaggio da una fase esplorativa a modifiche multi-file.
- **Informazioni esposte:** burn rate corrente (`tok/min`), burn rate precedente (`tok/min`), rapporto (`×`), delta assoluto, conteggio inferenze in entrambe le finestre.

#### 6. `quota_pressure` (Scope: `account`, un'istanza indipendente per ciascuna `(categoria, finestra)`)

- **Metriche:** `subscription.categories[]` (Codex) e `subscription.cached.windows[]` + `subscription.rateLimitStatus` (Claude Code).
- **Requisiti di validità espliciti per entrambi i provider:**
  - *Codex:* `window.usedPercent !== undefined`, `window.resetPassedWithoutNewObservation === false` e `window.ageMs !== undefined && window.ageMs <= 15 min` (`900.000 ms`, allineato alla freschezza informativa di ADR-004).
  - *Claude Code:* `cached.fetchedAtMs !== undefined`, `cached.ageMs <= cached.staleThresholdMs` (`15 min`), `window.usedPercent !== undefined` e `window.resetPassedWithoutNewObservation === false`.
  - In assenza di validità (quota assente, `ageMs > 15 min` o reset superato senza nuova osservazione) → **`not_evaluable`**, mai `resolved` e mai alcun avviso basato su quote obsolete.
- **Attivazione:** Warning `usedPercent >= 80%`; Critical `usedPercent >= 95%`.
- **Risoluzione (isteresi):** Critical scende a Warning se `< 92%`; Warning si risolve su osservazione valida con `usedPercent < 75%` (inclusa una nuova osservazione post-reset).
- **Motivazione soglie:** baseline richiesta da ADR-005; separazione rigorosa di finestre e categorie (`primary` 5h vs `secondary` 7d, `five_hour` vs `seven_day` vs `limits[]`).
- **Falsi positivi noti:** quota condivisa tra più sessioni o dispositivi sullo stesso account (non attribuibile alla sola sessione corrente).
- **Informazioni esposte:** percentuale utilizzata, percentuale residua, finestra/categoria, `resetsAtMs`, età osservazione (`ageMs`), flag cached vs observed.

### 3. Contratto delle segnalazioni e lifecycle (`src/monitoring/`)

```text
src/
├── monitoring/
│   ├── rules.ts        (soglie centralizzate, tipi PreventiveAlert, 6 funzioni pure di valutazione)
│   └── monitoring.ts   (PreventiveMonitor: sottoscrizione a UsageObservatory, stato e lifecycle)
├── observatory/
│   └── metrics.ts      (+ BurnRateWindowSummary `previousWindow` nel singolo pass di computeBurnRate)
└── extension.ts        (istanziazione PreventiveMonitor, dispose, getMonitoringSnapshot/onDidUpdateMonitoring)
test/
├── monitoring-rules.test.ts
└── monitoring.test.ts
```

- **Modello `PreventiveAlert`:**
  - `id: string` (chiave stabile: `${provider}:session:${ruleId}` oppure `${provider}:account:quota_pressure:${windowKey}`), `ruleId`, `provider`, `scope: 'session' | 'account'`, `sessionId?`, `quotaCategory?`, `quotaWindowId?`.
  - `state: 'active' | 'resolved' | 'not_evaluable'`, `severity?: 'warning' | 'critical'` (definita solo se `state === 'active'`).
  - `observedValue?`, `threshold?`, `unit?`, `activatedAtMs?`, `updatedAtMs`, `resolvedAtMs?`.
  - `evidence: Record<string, number | string | boolean>`, `coverage: { evaluable: boolean; status: string; reason?: string }`.
  - `summary: string` — descrizione esclusivamente fattuale e neutrale (mai giudizi di spreco, inutilità del contesto o previsioni di esaurimento quota).
- **Lifecycle in `PreventiveMonitor`:**
  - Si sottoscrive esclusivamente a `observatory.onDidUpdate(...)` (zero timer, zero watcher, zero letture dirette di file, zero persistenza, zero storico permanente).
  - Rivaluta un provider **solo** se il riferimento `ProviderObservatorySnapshot` è cambiato rispetto all'ultima valutazione (`O(1)`).
  - Mantiene una sola voce per `id`: preserva `activatedAtMs` mentre la condizione resta `active`, aggiorna evidenze e `updatedAtMs` senza generare duplicati.
  - **Cambio sessione:** elimina tutte le segnalazioni `scope === 'session'` della sessione precedente e valuta da zero la nuova sessione; mantiene intatte e indipendenti le segnalazioni `scope === 'account'` (`quota_pressure`).
  - **Perdita temporanea di copertura/freschezza:** una condizione `active` che diventa non valutabile passa a `not_evaluable`, **mai** a `resolved`.
  - **Notifica minimale (`onDidUpdate`) e `dispose()`:** notifica i sottoscrittori solo a variazione effettiva di stato/severità/evidenze; `dispose()` annulla la sottoscrizione dall'Observatory e svuota i listener.
- **Esposizione read-only (`src/extension.ts`):** estende l'handle restituito da `activate()` con `getMonitoringSnapshot()` e `onDidUpdateMonitoring(listener)` senza introdurre API pubbliche versionate, comandi o UI.

### 4. Strategia di testing

Stack `node:test` + `node:assert/strict` (zero nuove dipendenze):

- `test/monitoring-rules.test.ts`: attivazione Warning/Critical e isteresi di risoluzione per tutti i 6 indicatori, dati mancanti e copertura parziale, discontinuità di contesto (compaction, cambio modello, multi-iterazione server-side), anti-ripresa dopo inattività e denominatore zero su `Consumption Acceleration`, decadimento burn rate, quote stale e reset superato (transizione a `not_evaluable`, mai `resolved`).
- `test/monitoring.test.ts`: lifecycle completo con `UsageObservatory`, assenza di duplicati su refresh ripetuti, cambio sessione (rimozione alert di sessione + preservazione alert quota account), indipendenza tra provider, rilascio sottoscrizioni su `dispose()`.

## Motivazioni

- **Zero duplicazione e overhead minimo (Ponytail):** nessuna collezione duplicata, nessun nuovo timer/watcher, una sola estensione `previousWindow` nel pass già esistente di `computeBurnRate()` e check $O(1)$ sul riferimento dello snapshot per saltare i provider invariati.
- **Falsi positivi contenuti:** isteresi esplicita, doppia soglia assoluta+relativa su `Context Growth`, requisiti di baseline minima su `Consumption Acceleration` e soglie di `Agentic Intensity` calibrate sulle mediane/`p90` reali.
- **Neutralità semantica:** tutte le descrizioni riportano esclusivamente quantità e rapporti misurati, senza giudizi normativi né stime predittive.

## Alternative rilevanti

1. **Calcolare `previousWindow` dentro `PreventiveMonitor` leggendo `SentraState`:** violerebbe l'incapsulamento dell'Observatory e accoppierebbe il monitoring allo stato interno di `ProviderSessionMonitor`; esporre `previousWindow` su `BurnRateMetrics` mantiene il contratto pulito e testabile con funzioni pure.
2. **Valutare `Repeated Context Processing` sul cumulativo dell'intera sessione:** resterebbe bloccato in stato `active` per tutta la durata residua di una sessione lunga anche dopo il ritorno a carichi modesti; la finestra mobile di 5 min consente attivazione e risoluzione coerenti.
3. **Soglia di freschezza differenziata per `Quota Pressure` su Codex (`30 min`) vs Claude (`15 min`):** una finestra uniforme di `15 min` allineata ad ADR-004 è più semplice e conservativa, ma resta facilmente regolabile se preferito.

## Conseguenze e limitazioni

- `Context Pressure` resta sempre `not_evaluable` su Claude Code finché i transcript non espongono una capacità verificabile della context window.
- `Repeated Context Processing` adotta il controllo conservativo `usage.subagents.inferenceCount > 0` per dichiarare non disponibile il multiplo rispetto al contesto principale (`subagents_present_scope_mismatch`), anche qualora i subagent appartengano a fasi precedenti della stessa sessione e non abbiano contribuito alla finestra recente di 5 minuti; tale scelta evita nuove aggregazioni complesse dedicate e applica esplicitamente la semantica condizionale sui soli volume assoluto e share relativo.
- `Agentic Intensity` considera solo le inferenze dirette della sessione principale per l'ultimo turn (i subagent sono riportati a livello di sessione ma non attribuiti al singolo turn in assenza di un legame nativo verificabile).
- `Quota Pressure` risulta `not_evaluable` in assenza di osservazioni recenti (es. `~/.claude.json` stantio o reset superato), comportamento intenzionale per evitare falsi allarmi su dati obsoleti.
- Le soglie sono centralizzate nel codice (`MONITORING_THRESHOLDS`) come convenzioni operative V0.1 non ancora configurabili dall'utente (configurazione e UI appartengono ad ADR-007).

## Criteri di accettazione

### Proposta

- [x] Compatibilità con ADR-004 verificata sul codice reale.
- [x] Sei indicatori valutati rispetto alle metriche disponibili e calibrati sulle sessioni correnti reali.
- [x] Condizioni di attivazione, risoluzione (con isteresi) e requisiti di copertura espliciti.
- [x] Soglie motivate e gestione dei dati insufficienti (`not_evaluable`) definita.
- [x] Questioni aperte documentate.
- [x] ADR-005 salvato in `docs/ADR/ADR-005-preventive-monitoring.md` con stato `Proposed`.

### Implementazione — esclusivamente dopo approvazione

- [x] Estensione minimale `previousWindow` su `BurnRateMetrics` implementata senza regressioni.
- [x] Sei indicatori implementati in `src/monitoring/rules.ts` con soglie centralizzate e descrizioni fattuali.
- [x] Lifecycle in `src/monitoring/monitoring.ts` integrato via `onDidUpdate`, senza timer/watcher/persistenza/duplicati.
- [x] Gestione corretta di cambio sessione, condizioni `not_evaluable`, indipendenza tra provider e `dispose()`.
- [x] Snapshot read-only esposto dall'handle di `activate()` senza UI o funzionalità di ADR-006/007.
- [x] Zero nuove dipendenze; `npm run build`, `npm run typecheck`, TS `6.0.3`, `npm test`, smoke test Extension Host e `vsce package` superati.

## Questioni aperte

Nessuna. Tutte le decisioni sono state approvate, implementate e verificate:

1. **Estensione `previousWindow` su `BurnRateMetrics`:** implementata la finestra precedente non sovrapposta `(nowMs - 10m, nowMs - 5m]` in `src/observatory/metrics.ts` (più `latestTurnId`/`latestTurnStatus` su `AgenticMetrics` e tracking di freschezza delle quote Codex nella signature degli aggiornamenti).
2. **Soglie iniziali centralizzate e freschezza quote:** implementate tutte le soglie V0.1 centralizzate in `MONITORING_THRESHOLDS` come convenzioni operative iniziali e la finestra informativa uniforme di `15 min` per entrambi i provider, con verifica esplicita della coerenza di scope sul multiplo di `Repeated Context Processing`.
3. **Esposizione read-only su `activate()`:** esposti `getMonitoringSnapshot()` e `onDidUpdateMonitoring()` sull'handle read-only restituito da `activate()`, con freezing runtime degli snapshot pubblicati e senza API pubbliche versionate, comandi o componenti UI.

## Esito della revisione e validazione

Validazione eseguita il 2026-11-24 su Windows (`Node.js v24.11.1`, `VS Code 1.147.0`, zero nuove dipendenze):

- **Revisione tecnica (problemi individuati e corretti):**
  - *[Media]* Immutabilità read-only degli snapshot (`src/monitoring/monitoring.ts`): applicato `Object.freeze` profondo su `PreventiveAlert`, `evidence`, `coverage`, array `alerts`, `ProviderMonitoringSnapshot` e `MonitoringSnapshot` impedendo mutazioni esterne allo stato interno o agli snapshot già pubblicati.
  - *[Media]* Completezza di `snapshotChangeSignature` (`src/observatory/metrics.ts`): aggiunti `contextWindowTokens` e `isCurrentContextFromLatestInference` così che perdita/recupero della validità del contesto pubblichino sempre l'aggiornamento; protetto `shortPrevTransition` con `windowCoverage !== 'unavailable'` per mantenere $O(1)$ le sessioni `snapshot_only`.
  - *[Media]* Turno vuoto appena avviato o completato (`src/observatory/metrics.ts`): `inferencesInLatestTurn` viene ora esposto anche quando `latestTurn.status !== undefined` (`started`/`completed`/`aborted`) con `0` inferenze nel nuovo turn.
  - *[Bassa]* Notifica cambio `turnPhase` e chiarezza `Repeated Context Processing` (`src/monitoring/monitoring.ts`, `src/monitoring/rules.ts`): incluso `summary` in `monitoringSignature` per notificare transizioni `current → completed`/`aborted` e resa esplicita `(context multiple unavailable)` nella descrizione quando il multiplo non è calcolabile.
- **Verifica sui dati reali (read-only sulle sole due sessioni correnti):**
  - **Codex:** `context_pressure` `resolved` (`61,0%`, `289.741 / 475.000`), `context_growth` `resolved` (`+22.449` / `+8,4%` su 5 inferenze), `repeated_context_processing` `resolved` (`0` tok, `subagents_present_scope_mismatch`), `agentic_intensity` **`active` (`warning`)** (`52` inferenze dirette >= `30`, `turnPhase: completed`, `6` subagent separati), `consumption_acceleration` `resolved` (`ratio: 0`, `cur: 0` vs `prev: 488.133 tok/min` su `9` inferenze), `quota_pressure` (`primary` `100%`, `secondary` `37%`) `not_evaluable` (`expired_reset`, età `~99,5 h`).
  - **Claude Code:** `context_pressure` `not_evaluable` (`context_window_unavailable`), `context_growth` `resolved` (`+3.397` / `+0,6%` su 5 inferenze), `repeated_context_processing` `resolved` (`0` tok, `subagents_present_scope_mismatch`), `agentic_intensity` `resolved` (`19` inferenze dirette < `30`, `38` subagent separati), `consumption_acceleration` `not_evaluable` (`insufficient_baseline_activity`), `quota_pressure` (`5` finestre) tutte `not_evaluable` (`expired_reset`, età `~266 h`).
- **Prestazioni (confronto con baseline ADR-004):**
  - Valutazione pura delle 6 regole (`evaluateProviderRules`, entrambi i provider): **`51,8 µs`** wall (`~0 µs` CPU misurabile).
  - Inizializzazione complessiva: **`2.586,7 ms`** (`467,6 ms` Codex + `2.119,0 ms` Claude; baseline ADR-004: `2.599 ms`).
  - Refresh idle: Codex `46,1 ms`, Claude `95,8 ms`, combinato `141,9 ms` wall / `190,6 ms` CPU (baseline ADR-004: `48,1 ms` / `107,4 ms`); su fixture controllata `idleBeforeDecay` `1,46 ms`, `idleAfterDecay` `1,57 ms`, append incrementale `6,79 ms` (baseline `7,5 ms`), `6` alert totali dopo `10` cambi sessione.
  - Memoria & storage: picco RSS iniziale `238,4 MB` *(baseline `234,8 MB`)*; steady state post-GC su 20 tick idle **`23,4 MB → 23,3 MB heap`** *(baseline `22,9 MB`)*; storage su disco `0 B`; file invariati riletti `0`.
- **Extension Host & validazione finale:** `npm run build` (`exit 0`), `npm run typecheck` (`exit 0`), TypeScript `6.0.3` integrato in VS Code (`0` diagnostiche), `npm test` (`34/34 pass`, `454 ms`), smoke test Extension Development Host (`EXIT_CODE=0`, attivazione `onStartupFinished`, snapshot monitoring frozen verificati con `Object.isFrozen`, `monEvents: 2`, comando `sentra.verifyInstallation` verificato), `npm run package` (`20` file, `56,48 KB`, zero dipendenze runtime).
