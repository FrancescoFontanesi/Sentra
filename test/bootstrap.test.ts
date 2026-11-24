import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

interface ExtensionManifest {
  name: string;
  displayName: string;
  version: string;
  publisher: string;
  engines: { vscode: string };
  categories: string[];
  activationEvents: string[];
  main: string;
  contributes?: {
    commands?: Array<{ command: string; title: string }>;
  };
  dependencies?: Record<string, string>;
}

const rootDir = path.resolve(__dirname, '..', '..');
const manifestPath = path.join(rootDir, 'package.json');
const manifest = JSON.parse(
  fs.readFileSync(manifestPath, 'utf8')
) as ExtensionManifest;

test('manifest contains coherent bootstrap metadata and no runtime dependencies', () => {
  assert.equal(manifest.name, 'sentra');
  assert.equal(manifest.displayName, 'Sentra');
  assert.equal(manifest.version, '0.0.1');
  assert.equal(manifest.publisher, 'sentra-local');
  assert.equal(manifest.engines.vscode, '^1.101.0');
  assert.deepEqual(manifest.categories, ['Other']);
  assert.equal(manifest.main, './out/src/extension.js');
  assert.equal(manifest.dependencies, undefined);
});

test('compiled entry point declared in manifest exists', () => {
  const entryPoint = path.resolve(rootDir, manifest.main);
  assert.equal(fs.existsSync(entryPoint), true, `Missing entry point: ${entryPoint}`);
});

test('verify installation command is declared with implicit activation', () => {
  assert.deepEqual(manifest.activationEvents, []);
  const commands = manifest.contributes?.commands ?? [];
  assert.deepEqual(commands, [
    {
      command: 'sentra.verifyInstallation',
      title: 'Sentra: Verify Installation',
    },
  ]);
});
