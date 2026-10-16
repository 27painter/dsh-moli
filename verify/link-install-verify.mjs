// The `link:`/junction install route (the README's first way to install) puts
// the plugin at a real path whose upward node_modules chain cannot resolve
// `@deepseek-ai/schemastery`. The host must still load the plugin and register
// `moli_fetch` / `moli_probe` — they are the plugin's reason to exist — while
// the settings form (the live Config schema) simply does not appear.
//
// This suite reproduces that environment: it copies index.js + lib/ into a
// temp tree with no node_modules and imports the plugin from there in a child
// process, so `@deepseek-ai/schemastery` cannot resolve. The child reports the
// resulting shape and the parent asserts on it.
import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// fileURLToPath, not `new URL(...).pathname`: on Windows a file URL's pathname
// is `/C:/...` and join() re-reads the leading `/C:` as a drive letter, yielding
// a doubled `C:\C:\...` prefix (ENOENT). fileURLToPath returns the native path.
const REPO = fileURLToPath(new URL('..', import.meta.url));

let failed = 0;
const check = (name, ok, detail) => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` -- ${detail}` : ''}`);
  if (!ok) failed += 1;
};

const dir = mkdtempSync(join(tmpdir(), 'dsh-moli-link-verify-'));
try {
  cpSync(join(REPO, 'index.js'), join(dir, 'index.js'));
  cpSync(join(REPO, 'lib'), join(dir, 'lib'), { recursive: true });

  // The child imports from the temp tree. Its cwd is the temp tree, whose
  // node_modules chain does not exist, so the bare `@deepseek-ai/schemastery`
  // specifier cannot resolve — exactly the link-install case. The plugin's
  // own files resolve as relative imports.
  const child = `
    const m = await import(${JSON.stringify(pathToFileURL(join(dir, 'index.js')).href)});
    const registered = new Map();
    m.apply({
      tools: { register: d => registered.set(d.name, d) },
      logger: { info() {} },
      on() {},
      get: () => null,
    }, {});
    console.log(JSON.stringify({
      config: typeof m.Config,
      fetch: registered.has('moli_fetch'),
      probe: registered.has('moli_probe'),
    }));
  `;
  const run = spawnSync(process.execPath, ['--input-type=module', '-e', child], {
    cwd: dir,
    encoding: 'utf8',
    timeout: 30000,
  });

  check('plugin loads from a link-style tree (no schemastery)', run.status === 0,
    run.status === 0 ? '' : `exit ${run.status}: ${run.stderr?.slice(-300)}`);
  if (run.status === 0) {
    let out;
    try { out = JSON.parse(run.stdout.trim().split('\n').pop()); } catch (e) { out = null; }
    check('Config is undefined without schemastery (no settings form)', out?.config === 'undefined',
      out ? `Config=${out.config}` : 'unparseable child output');
    check('moli_fetch still registers', out?.fetch === true, out ? `fetch=${out.fetch}` : 'unparseable');
    check('moli_probe still registers', out?.probe === true, out ? `probe=${out.probe}` : 'unparseable');
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}

console.log(`\nresult: ${failed === 0 ? 'passed' : 'failed'} (link-install)`);
process.exit(failed === 0 ? 0 : 1);
