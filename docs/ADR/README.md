# Architecture Decision Records (ADR)

Indice sintetico dello sviluppo incrementale di Sentra.

| ID | Titolo | Stato | Riepilogo operativo |
|---|---|---|---|
| [ADR-001](ADR-001-project-bootstrap.md) | Project Bootstrap | Approved | Inizializzazione estensione VS Code TypeScript (`NodeNext`/CJS, `engines.vscode: ^1.101.0`, `node:test`, `vsce`, comando `Sentra: Verify Installation`). |
| [ADR-002](ADR-002-provider-acquisition.md) | Provider Acquisition | Approved | Acquisizione passiva read-only per Codex e Claude Code: lettura JSONL incrementale, Zstandard nativo `node:zlib`, watcher mirato e parser degli eventi nativi. |
| [ADR-003](ADR-003-data-model-persistence.md) | Data Model & Session-Centric State | Approved | Modello dati canonico, normalizzazione token, deduplicazione/riconciliazione idempotente e monitoraggio in memoria circoscritto alla sessione corrente per provider (nessuna persistenza globale). |
| [ADR-004](ADR-004-usage-observatory.md) | Usage Observatory | Approved | Sottosistema Usage Observatory integrato nel lifecycle VS Code (`onStartupFinished`, timer unico 3 s, handle read-only): metriche cumulative/agentic, context evolution, burn rate 5 min e subscription usage separata. |
| [ADR-005](ADR-005-preventive-monitoring.md) | Preventive Monitoring | Approved | Sei indicatori deterministici (`context_pressure`, `context_growth`, `repeated_context_processing`, `agentic_intensity`, `consumption_acceleration`, `quota_pressure`) con isteresi, `PreventiveMonitor` passivo su `onDidUpdate` e snapshot read-only frozen. |
