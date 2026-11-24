# ADR-001 — Project Bootstrap

- **Identificativo:** ADR-001
- **Data:** 2026-11-24
- **Stato:** Approved

## Contesto

**Sentra** è un'estensione VS Code in TypeScript dedicata al monitoraggio locale, passivo e deterministico dell'usage e all'analisi on demand delle configurazioni degli harness **Codex** e **Claude Code**. L'architettura prevede due sottosistemi indipendenti: **Usage Observatory** e **Harness Auditor**, senza backend cloud, daemon, proxy o dipendenze da modelli linguistici.

Questo ADR definisce esclusivamente le fondamenta tecniche del repository (stack, configurazione, build, debugging, testing, packaging e scaffolding minimo), senza implementare funzionalità applicative né creare moduli placeholder per componenti futuri.

### Verifica dell'ambiente di sviluppo

Verifica eseguita sul workspace `f:\Sentra` prima dell'implementazione:

| Componente | Stato / Versione rilevata | Note |
|---|---|---|
| Workspace `f:\Sentra` | Presente e vuoto | Inizializzato su branch `main` con `git init -b main` |
| Node.js (host) | `v24.11.1` | Soddisfa `node:test`, ES2022 e `@vscode/vsce` (`>= 22`) |
| npm | `11.6.2` | Supporta `npm ci` e lockfile v3 |
| Git | `2.41.0.windows.3` | `user.name` e `user.email` configurati; `init.defaultBranch` non impostato |
| VS Code | `1.147.0` (`x64`) | Installato in `D:\Microsoft VS Code\bin\code.cmd` |
| Extension Host runtime | Node.js `24.22.1`, Electron `43.8.9`, V8 `15.0.245.31` | Compatibile con ES2022 e CommonJS |

## Decisione

### 1. Stack tecnico e versioni delle dipendenze

Nessuna dipendenza runtime viene introdotta in ADR-001. Le sole `devDependencies` adottate sono:

| Pacchetto | Versione | Motivazione |
|---|---|---|
| `typescript` | `^5.9.3` | Ultima release stabile della serie 5.x; piena compatibilità con `CommonJS`, `tsserver` e problem matcher `$tsc` / `$tsc-watch` di VS Code (evita i breaking change di TS 6.x/7.x). |
| `@types/vscode` | `1.101.0` | Versione esatta senza caret, allineata a `engines.vscode: "^1.101.0"`, per impedire l'utilizzo accidentale di API successive alla versione minima dichiarata. |
| `@types/node` | `^22.20.5` | Tipi Node.js 22 LTS coerenti con l'introduzione di Node.js 22 nell'Extension Host di VS Code `1.101.0` e compatibili con `typescript@^5.9.3`. |
| `@vscode/vsce` | `^4.1.1` | Ultima versione stabile per packaging VSIX locale (richiede Node `>= 22`, soddisfatto dall'ambiente). |

### 2. Configurazione TypeScript, build e separazione degli artefatti

- **Linguaggio e compilazione:** TypeScript in `strict: true`, `target: "ES2022"`, `lib: ["ES2022"]`, `types: ["node"]`, `module: "NodeNext"`, `moduleResolution: "NodeNext"`, `sourceMap: true`. In abbinamento a `"type": "commonjs"` nel `package.json`, l'output compilato resta CommonJS privo di opzioni deprecate in TypeScript 6.x.
- **Compilazione diretta via `tsc`:** nessun bundler iniziale.
- **Layout `tsconfig.json`:** singolo file `tsconfig.json` con `rootDir: "."`, `outDir: "out"`, `include: ["src", "test"]`.
  - L'output compilato viene emesso in `out/src/` e `out/test/`.
  - Il campo `main` del `package.json` punta a `./out/src/extension.js`.
  - `.vscodeignore` esclude `out/test/**`, `**/*.map`, `**/*.ts`, `src/**`, `test/**`, `docs/**`, `.vscode/**`, `.gitignore`, `tsconfig.json` e `*.vsix`, garantendo che il VSIX contenga solo il codice necessario all'esecuzione.

### 3. Testing

- **Test di bootstrap (senza VS Code):** runner nativo `node:test` e `node:assert/strict` in `test/bootstrap.test.ts`, eseguiti tramite `npm run build && node --test "out/test/**/*.test.js"`.
- **Perimetro dei test:** verifica della coerenza dei metadati essenziali del manifest (incluse zero dipendenze runtime), della presenza dell'entry point compilato dichiarato in `main` e della corretta dichiarazione del comando `sentra.verifyInstallation` con attivazione implicita. Nessun mock di VS Code.
- **Smoke test:** avvio dell'Extension Development Host e verifica dell'attivazione ed esecuzione del comando `Sentra: Verify Installation`.

### 4. Debugging e task VS Code

- `.vscode/launch.json`: configurazione `Run Extension` (`type: "extensionHost"`, `preLaunchTask: "npm: watch"`, `outFiles: ["${workspaceFolder}/out/**/*.js"]`) per debugging tramite `F5` con source map.
- `.vscode/tasks.json`: task per `npm: build` e `npm: watch` con `problemMatcher: "$tsc"` / `"$tsc-watch"`.
- `.vscode/settings.json`: `"typescript.tsdk": "node_modules/typescript/lib"` per allineare il language server di VS Code alla versione TypeScript del workspace (`5.9.3` rispetto alla `6.0.3` integrata in VS Code `1.147.0`).

### 5. Manifest dell'estensione (`package.json`)

- `name`: `sentra`
- `displayName`: `Sentra`
- `version`: `0.0.1` (sviluppo iniziale; milestone di rilascio `0.1.0`)
- `publisher`: `sentra-local` (identificativo provvisorio per sviluppo e packaging locale)
- `categories`: `["Other"]`
- `description`: coerente con Usage Observatory e Harness Auditor per Codex e Claude Code
- `engines.vscode`: `^1.101.0` (coerente con l'introduzione di Node.js 22 nell'Extension Host)
- `type`: `commonjs` (esplicito per preservare l'output CommonJS con `module: "NodeNext"`)
- `main`: `./out/src/extension.js`
- `activationEvents`: `[]` (attivazione implicita `onCommand:sentra.verifyInstallation` generata da `contributes.commands`)
- `contributes.commands`: un unico comando `sentra.verifyInstallation` con titolo `Sentra: Verify Installation`
- `license`: non definita durante il bootstrap; scelta rimandata prima dell'eventuale pubblicazione.

### 6. Script npm

- `vscode:prepublish`: `npm run build`
- `build`: `tsc -p .`
- `watch`: `tsc -watch -p .`
- `typecheck`: `tsc --noEmit -p .`
- `test`: `npm run build && node --test "out/test/**/*.test.js"`
- `package`: `vsce package`

### 7. Scaffolding iniziale

```text
Sentra/
├── .vscode/
│   ├── launch.json
│   ├── settings.json
│   └── tasks.json
├── docs/
│   └── ADR/
│       └── ADR-001-project-bootstrap.md
├── src/
│   └── extension.ts
├── test/
│   └── bootstrap.test.ts
├── .gitignore
├── .vscodeignore
├── CHANGELOG.md
├── package.json
├── package-lock.json
├── README.md
└── tsconfig.json
```

La directory `out/` è generata dalla build ed esclusa da Git. Nessuna directory vuota o modulo placeholder per Observatory o Auditor.

### 8. Version control

- Repository Git locale inizializzato con `git init -b main`.
- Nessun remote configurato, nessun push, nessun tag o release.
- `.gitignore` esclude `node_modules/`, `out/`, `*.vsix`, log, file temporanei e file sensibili (`.env*`).

## Motivazioni

- **Minima complessità:** `tsc` + `node:test` + `@vscode/vsce` eliminano bundler, framework di test e dipendenze non necessarie in fase di bootstrap.
- **Sicurezza delle API:** fissare `@types/vscode` a `1.101.0` (senza caret) impedisce di usare per errore API non presenti nella versione minima `^1.101.0`, coerente con Node.js 22 nell'Extension Host.
- **Nessuna astrazione artificiale:** il comando `Sentra: Verify Installation` è implementato direttamente in `src/extension.ts`; `test/bootstrap.test.ts` verifica invece invarianti concreti del bootstrap senza mock di VS Code.
- **Riproducibilità e pulizia del VSIX:** `package-lock.json` + `npm ci`, `vscode:prepublish` e `.vscodeignore` garantiscono installazioni riproducibili e pacchetti privi di sorgenti, test e source map.

## Alternative rilevanti

1. **TypeScript `6.x` o `7.0.2` invece di `5.9.3`:** scartate in fase di bootstrap perché `7.0.2` omette `tsserver` e introduce cambiamenti architetturali non necessari.
2. **Due file `tsconfig` (`tsconfig.json` con `rootDir: "src"` + `tsconfig.test.json` -> `out-test/`):** scartata per mantenere un unico file di configurazione TypeScript.
3. **Modulo `src/verify.ts` separato per test unitari:** scartato perché introduce una separazione artificiale per un comando minimale di bootstrap.
4. **Bundler (`esbuild`):** non giustificato con zero dipendenze runtime; valutabile in ADR futuri solo se necessario.

## Conseguenze e limitazioni

- Con un singolo `tsconfig.json` (`rootDir: "."`), `main` punta a `./out/src/extension.js` e `.vscodeignore` deve escludere `out/test/**`.
- L'assenza di `license` e `repository` nel `package.json` può generare avvisi non bloccanti durante `vsce package`.
- L'assenza di un bundler implica che eventuali dipendenze runtime future dovranno essere gestite nel VSIX o tramite un ADR dedicato.

## Criteri di accettazione

### Fase Proposta

- [x] Ambiente di sviluppo verificato (`f:\Sentra`, Node, npm, Git, VS Code, Extension Host runtime).
- [x] Compatibilità dello stack verificata e versioni motivate.
- [x] Scaffolding e separazione `src/` / `test/` / `out/` / VSIX validati.
- [x] ADR salvato in `docs/ADR/ADR-001-project-bootstrap.md`.

### Fase Implementazione

- [x] Repository Git locale inizializzato sul branch `main`.
- [x] Scaffolding conforme alle decisioni approvate.
- [x] Stack tecnico funzionante e dipendenze riproducibili (`npm ci`).
- [x] Zero dipendenze runtime.
- [x] Build (`npm run build`), type checking (`npm run typecheck`) e test (`npm test`) superati.
- [x] Extension Development Host avviabile e comando `Sentra: Verify Installation` funzionante.
- [x] Packaging locale VSIX (`npm run package`) completato e contenuto verificato.
- [x] Documentazione iniziale coerente con lo stato del progetto.
- [x] Nessuna funzionalità estranea al bootstrap.
- [x] ADR aggiornato allo stato `Approved` dopo validazione positiva.
- [x] Commit locale completato (`chore: initialize Sentra (ADR-001)`) e working tree pulito.

## Questioni aperte

Nessuna. Tutte le questioni aperte della fase di proposta sono state risolte prima dell'implementazione:

- `publisher`: `sentra-local` (provvisorio per sviluppo/packaging locale).
- `engines.vscode` / `@types/vscode` / `@types/node`: `^1.101.0` / `1.101.0` (esatto) / `^22.20.5`.
- Layout `tsconfig`: singolo `tsconfig.json` (`rootDir: "."`, `outDir: "out"`, `main: "./out/src/extension.js"`).
- Licenza: non definita nel bootstrap; da definire prima di eventuale pubblicazione.

## Esito della validazione

Validazione completata il 2026-11-24 su Windows (`Node.js v24.11.1`, `npm 11.6.2`, `VS Code 1.147.0`, Extension Host `Node.js 24.22.1`):

- **Installazione riproducibile (`npm ci`):** superata (`exit 0`, 120 pacchetti dev installati, zero dipendenze runtime).
- **Build (`npm run build`) e type checking (`npm run typecheck`):** superati senza errori né avvisi di deprecazione (`exit 0`) con `module`/`moduleResolution: "NodeNext"` e `"type": "commonjs"`, verificati sia con TypeScript del workspace (`5.9.3`) sia con TypeScript integrato in VS Code (`6.0.3`). Output CommonJS confermato in `out/src/extension.js` (`exports.activate`, `require("vscode")`).
- **Test (`npm test`):** superati (`3/3 pass` con `node --test "out/test/**/*.test.js"` verificato su Windows).
- **Extension Development Host e comando di verifica:** verificati avviando `Code.exe --extensionDevelopmentPath=f:\Sentra` con `--extensionTestsPath` in un profilo isolato (`exit 0`, `extensionId: "sentra-local.sentra"`, `isActiveBefore: false`, `isActiveAfter: true`, `commandRegistered: true`). Nota: l'avvio interattivo tramite tasto `F5` (`launch.json` + `npm: watch`) e la visualizzazione del toast nell'interfaccia VS Code non sono stati eseguiti manualmente in sessione GUI.
- **Packaging VSIX (`npm run package`):** dopo la rimozione di un link Markdown relativo in `README.md` (segnalato da `vsce` in assenza di `repository`), `vsce package` ha generato `sentra-0.0.1.vsix` (`6` file, `3.63 KB`: `[Content_Types].xml`, `extension.vsixmanifest`, `extension/changelog.md`, `extension/package.json`, `extension/readme.md`, `extension/out/src/extension.js`), confermando l'esclusione di sorgenti, test, source map, `docs/`, `.vscode/` e `node_modules/`. Avvisi non bloccanti attesi: assenza di `repository` e `LICENSE`.
