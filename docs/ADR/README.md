# Architecture Decision Records (ADR)

Indice sintetico dello sviluppo incrementale di Sentra.

| ID | Titolo | Stato | Riepilogo operativo |
|---|---|---|---|
| [ADR-001](ADR-001-project-bootstrap.md) | Project Bootstrap | Approved | Inizializzazione estensione VS Code TypeScript (`NodeNext`/CJS, `engines.vscode: ^1.101.0`, `node:test`, `vsce`, comando `Sentra: Verify Installation`). |
| [ADR-002](ADR-002-provider-acquisition.md) | Provider Acquisition | Approved | Acquisizione passiva read-only per Codex e Claude Code: lettura JSONL incrementale, Zstandard nativo `node:zlib`, watcher mirato e parser degli eventi nativi. |
