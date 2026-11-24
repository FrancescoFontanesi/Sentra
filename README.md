# Sentra

VS Code extension for local, passive usage monitoring (**Usage Observatory**) and deterministic configuration auditing (**Harness Auditor**) of Codex and Claude Code.

> Current status: **Project Bootstrap (`0.0.1`)** — see `docs/ADR/ADR-001-project-bootstrap.md`.

## Prerequisites

- Node.js `>= 22` (tested on `v24.11.1`)
- npm
- VS Code `>= 1.101.0`

## Setup

```bash
npm ci
```

## Development commands

- `npm run build` — compile TypeScript sources to `out/`
- `npm run watch` — watch mode compilation
- `npm run typecheck` — static type check without emitting files
- `npm test` — build and run bootstrap tests via `node:test`
- `npm run package` — build a local `.vsix` package via `@vscode/vsce`

## Debugging

Open the workspace in VS Code and press `F5` (`Run Extension`) to launch the Extension Development Host, then run **Sentra: Verify Installation** from the Command Palette.
