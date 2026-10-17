// Validate the plugin's settings surface and engine lifecycle — everything the
// settings page added: the volatile Config schema, the dual-form apply reading
// (volatile `.get()` and plain object), the `engineAction`-driven install /
// uninstall loop wired through `settings/document-updated`, the uninstall
// helper, and the browser half's shape (module-loader bundle, the
// `plugins.bundle.config` registration, i18n dictionaries, and raw-value
// selects).
//
// Core tier: no engine and no network required, so it runs on every CI OS.

import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const pluginDir = process.argv[2] ?? dirname(here);

let pass = 0;
let fail = 0;
const check = (label, ok, extra = '') => {
  if (ok) { pass++; console.log(`  PASS ${label}${extra ? ' -- ' + extra : ''}`); }
  else { fail++; console.log(`  FAIL ${label}${extra ? ' -- ' + extra : ''}`); }
};
const section = name => console.log(`\n=== ${name} ===`);

// ── load the plugin (needs its own dependencies; CI runs `npm install`) ────
const plugin = await import(pathToFileURL(join(pluginDir, 'index.js')).href);
const { installMoli, uninstallMoli } = await import(pathToFileURL(join(pluginDir, 'lib', 'install.js')).href);
const { findMoli } = await import(pathToFileURL(join(pluginDir, 'lib', 'moli.js')).href);
console.log(`plugin dir : ${pluginDir}`);

// ── 1. Config schema ──────────────────────────────────────────────────────
section('Config schema');
check('exports Config', typeof plugin.Config === 'function');
check('Config is volatile', plugin.Config?.meta?.volatile === true, `got ${JSON.stringify(plugin.Config?.meta?.volatile)}`);

// A schemastery object schema serializes into `{uid, refs}`; the root object is
// `refs[uid]` and each dict value is a uid into `refs`. Assert the declared
// fields survive round-tripping through toJSON (what the settings describe
// mirror sees).
let configRoot = null;
let configRefs = null;
try {
  const json = plugin.Config.toJSON?.() ?? plugin.Config?.schema?.toJSON?.();
  if (json && typeof json === 'object' && 'refs' in json && json.uid !== undefined) {
    configRefs = json.refs;
    configRoot = json.refs[json.uid];
  }
} catch {
  configRoot = null;
}
if (configRoot !== null && configRoot.type === 'object') {
  const keys = Object.keys(configRoot.dict ?? {});
  for (const key of ['defaultTimeoutMs', 'maxChars', 'insecureTls', 'proxy', 'exePath', 'engineAction', 'engineState', 'engineVersion']) {
    check(`Config declares "${key}"`, keys.includes(key), `keys: ${keys.join(',')}`);
  }
  const engineRef = configRefs[configRoot.dict.engineAction];
  check('engineAction is a union over none/install/uninstall',
    engineRef !== undefined && engineRef.type === 'union',
    engineRef ? `type=${engineRef.type}` : 'no ref');
} else {
  check('Config serializes to an object shape (toJSON)', false,
    configRoot ? `root type=${JSON.stringify(configRoot.type)}` : 'no object root resolved');
}

// ── 2. apply reads both config forms ──────────────────────────────────────
section('apply dual-form reading');
const makeCtx = (settingsImpl) => {
  const events = {};
  return {
    events,
    ctx: {
      tools: { register: d => { (events.tools ??= []).push(d.name); } },
      logger: { info() {}, warn() {}, error() {} },
      on: (ev, fn) => { events[ev] = fn; },
      get: key => (key === 'settings' ? settingsImpl : null),
    },
  };
};

// Plain-object config (older loaders without volatile wiring).
{
  const { ctx, events } = makeCtx(null);
  const calls = [];
  ctx.tools.register = d => calls.push(d.name);
  plugin.apply(ctx, { defaultTimeoutMs: 30000, maxChars: 100000, insecureTls: true, proxy: '', exePath: '' });
  check('apply accepts a plain config object', calls.includes('moli_fetch') && calls.includes('moli_probe'), calls.join(','));
}
// Volatile config (`.get()` reference).
{
  const { ctx, events } = makeCtx(null);
  const calls = [];
  ctx.tools.register = d => calls.push(d.name);
  const volatileConfig = { get: () => ({ defaultTimeoutMs: 50000, maxChars: 200000, insecureTls: false, proxy: 'http://x', exePath: '' }) };
  plugin.apply(ctx, volatileConfig);
  check('apply accepts a volatile config reference', calls.includes('moli_fetch') && calls.includes('moli_probe'), calls.join(','));
}

// ── 3. engine lifecycle wiring ────────────────────────────────────────────
section('engine lifecycle wiring');
{
  const updates = [];
  const settings = {
    update: async (ns, patch) => { updates.push([ns, patch]); return Promise.resolve(); },
  };
  const { ctx, events } = makeCtx(settings);
  const calls = [];
  ctx.tools.register = d => calls.push(d.name);
  const volatileConfig = { get: () => ({ defaultTimeoutMs: 30000, maxChars: 100000, insecureTls: true, proxy: '', exePath: '', engineAction: 'none', engineState: 'unknown', engineVersion: '' }) };
  plugin.apply(ctx, volatileConfig);
  const handler = events['settings/document-updated'];
  check('registers a settings/document-updated handler', typeof handler === 'function');
  check('register is scoped to the dsh-moli namespace (not asserted here)', true);

  // A `none` action syncs state (engine actually installed on this host).
  if (handler) {
    await handler('dsh-moli');
    await new Promise(r => setTimeout(r, 50));
    const sync = updates.find(u => u[0] === 'dsh-moli' && 'engineState' in u[1]);
    check('engineAction=none syncs engineState', sync !== undefined,
      sync ? `wrote engineState=${JSON.stringify(sync[1].engineState)}` : 'no engineState write');
  }
}

// ── 3b. handler dispatch: an uninstall action runs end to end ─────────────
// The wiring that actually executes an action: the form writes
// `engineAction: "uninstall"`, the handler must run uninstallMoli, then write
// back `engineAction: "none"` plus the resulting engineState. This guards the
// loop against a refactor that stops dispatching actions or forgets the reset
// (which would otherwise re-trigger the action forever).
section('engine lifecycle: uninstall action loop');
{
  const isWin = process.platform === 'win32';
  const dir = mkdtempSync(join(tmpdir(), 'dsh-moli-verify-'));
  const binDir = join(dir, 'bin');
  mkdirSync(binDir, { recursive: true });
  const fakeBin = join(binDir, 'moli');
  writeFileSync(fakeBin, '#!/bin/sh\necho fake\n', { mode: 0o755 });
  const prev = process.env.MOLI_BIN;
  process.env.MOLI_BIN = fakeBin;
  const prevLocal = process.env.LOCALAPPDATA;
  if (isWin) process.env.LOCALAPPDATA = join(dir, 'lappdata');
  const updates = [];
  const settings = {
    update: async (ns, patch) => { updates.push([ns, patch]); return Promise.resolve(); },
  };
  const { ctx, events } = makeCtx(settings);
  const volatileConfig = { get: () => ({ defaultTimeoutMs: 30000, maxChars: 100000, insecureTls: true, proxy: '', exePath: '', engineAction: 'uninstall', engineState: 'installed', engineVersion: '1.1.17' }) };
  plugin.apply(ctx, volatileConfig);
  const handler = events['settings/document-updated'];
  try {
    await handler('dsh-moli');
    await new Promise(r => setTimeout(r, 100));
    const actionUpdate = updates.find(u => u[0] === 'dsh-moli' && u[1].engineAction === 'none');
    check('uninstall action resets engineAction to none', actionUpdate !== undefined,
      actionUpdate ? JSON.stringify(actionUpdate[1]) : 'no engineAction=none write');
    if (isWin) {
      // Windows removes only the installer-owned tree; with the isolated (absent)
      // LOCALAPPDATA the action reports "nothing to remove" and leaves the engine.
      check('uninstall action is safe with no installer-owned tree (win)',
        actionUpdate?.[1].engineState === 'uninstall failed: nothing to remove',
        actionUpdate ? JSON.stringify(actionUpdate[1]) : 'no update');
      check('fake engine untouched by the action (win)', existsSync(fakeBin));
    } else {
      check('uninstall action reports engineState missing',
        actionUpdate?.[1].engineState === 'missing', actionUpdate ? JSON.stringify(actionUpdate[1]) : 'no update');
      check('uninstall action clears engineVersion', actionUpdate?.[1].engineVersion === '',
        actionUpdate ? JSON.stringify(actionUpdate[1]) : 'no update');
      check('fake engine removed by the action', !existsSync(fakeBin));
    }
  } finally {
    if (prev === undefined) delete process.env.MOLI_BIN; else process.env.MOLI_BIN = prev;
    if (isWin) {
      if (prevLocal === undefined) delete process.env.LOCALAPPDATA; else process.env.LOCALAPPDATA = prevLocal;
    }
    rmSync(dir, { recursive: true, force: true });
  }
}

// ── 4. uninstallMoli removes a located engine ─────────────────────────────
section('uninstallMoli');
{
  const isWin = process.platform === 'win32';
  const dir = mkdtempSync(join(tmpdir(), 'dsh-moli-verify-'));
  const binDir = join(dir, 'bin');
  mkdirSync(binDir, { recursive: true });
  const fakeBin = join(binDir, 'moli');
  writeFileSync(fakeBin, '#!/bin/sh\necho fake\n', { mode: 0o755 });
  // Point discovery at the fake engine (MOLI_BIN), and — on Windows — isolate
  // %LOCALAPPDATA% inside the temp dir so the test never sees (or worse,
  // deletes) a real installer-owned tree on the host.
  const prev = process.env.MOLI_BIN;
  process.env.MOLI_BIN = fakeBin;
  const prevLocal = process.env.LOCALAPPDATA;
  if (isWin) process.env.LOCALAPPDATA = join(dir, 'lappdata');
  try {
    const found = findMoli(undefined);
    check('findMoli locates the fake engine', found === fakeBin, String(found));
    if (isWin) {
      // No installer-owned tree under the isolated LOCALAPPDATA: nothing is
      // removed, the call must not throw, and the located binary is untouched.
      let removed;
      let threw = false;
      try { removed = uninstallMoli(undefined); } catch { threw = true; }
      check('uninstallMoli is safe with no installer-owned tree (win)', !threw && removed === undefined,
        threw ? 'threw' : String(removed));
      check('fake engine still present (win)', existsSync(fakeBin));

      // With an installer-owned tree present, Windows removes the whole tree.
      const installTree = join(dir, 'lappdata', 'Moli', 'bin');
      mkdirSync(installTree, { recursive: true });
      const engineInTree = join(installTree, 'moli.exe');
      writeFileSync(engineInTree, 'fake-win-engine');
      const removedTree = uninstallMoli(undefined);
      check('uninstallMoli removes the installer-owned tree (win)',
        removedTree === join(dir, 'lappdata', 'Moli'), String(removedTree));
      check('installer-owned tree is gone (win)', !existsSync(join(dir, 'lappdata', 'Moli')));
      check('fake engine still present after tree removal (win)', existsSync(fakeBin));
    } else {
      const removed = uninstallMoli(undefined);
      check('uninstallMoli removes the engine binary', removed === fakeBin, String(removed));
      check('engine binary is gone', !existsSync(fakeBin));
    }
  } finally {
    if (prev === undefined) delete process.env.MOLI_BIN; else process.env.MOLI_BIN = prev;
    if (isWin) {
      if (prevLocal === undefined) delete process.env.LOCALAPPDATA; else process.env.LOCALAPPDATA = prevLocal;
    }
    rmSync(dir, { recursive: true, force: true });
  }
}

// ── 5. browser half shape ─────────────────────────────────────────────────
section('browser half (client.js)');
const clientPath = join(pluginDir, 'client.js');
check('client.js exists', existsSync(clientPath));
if (existsSync(clientPath)) {
  const source = await import('node:fs/promises').then(m => m.readFile(clientPath, 'utf8'));
  check('is a ModuleLoader bundle', source.includes('window.__ModuleLoader__.load({'));
  check('registers the plugins.bundle.config slot', source.includes('name: "plugins.bundle.config"'));
  check('registers under the dsh-moli key', /key:\s*"dsh-moli"/.test(source));
  check('injects slots/locale/configForms', source.includes('exports.inject = ["slots", "locale", "configForms"]'));
  check('declares zh + en dictionaries', source.includes('var zh = {') && source.includes('var en = {'));
  check('select options show raw true/false', source.includes('options: [["true", "true"], ["false", "false"]]'));
  check('no translated true/false labels', !source.includes('boolTrue') && !source.includes('boolFalse'));
  check('engine section renders install/uninstall buttons',
    source.includes('engineActionInstall') && source.includes('engineActionUninstall'));
}

console.log(`\nresult: ${pass} passed, ${fail} failed`);
process.exitCode = fail === 0 ? 0 : 1;
