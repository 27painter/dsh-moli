// The empty-output regression: moli succeeding with no output is not a failure.
//
// Why this file exists: the plugin used to treat `status === 0 && bytes === 0`
// as an error and answer with "moli exited with status 0 and no output" plus a
// hint telling the caller to re-check the install. That is a wrong diagnosis
// for a page that simply has no content in the requested format -- exactly what
// a client-rendered page yields under `--disable-js` with `-d markdown`.
//
// The engine behaviour is asserted for real (exit 0, zero bytes) against a
// compiled stub, so this test does not depend on the network or on any
// particular site staying client-rendered.
import { spawnSync } from 'node:child_process';
import { existsSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const pluginDir = process.argv[2] ?? 'D:/dsh_plugins/dsh-moli';
const here = new URL('.', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/u, '$1');
const isWindows = process.platform === 'win32';
const stubs = {
  noop: join(here, isWindows ? 'noop-engine.exe' : 'noop-engine'),
  failing: join(here, isWindows ? 'fail-engine.exe' : 'fail-engine'),
  warning: join(here, isWindows ? 'warn-engine.exe' : 'warn-engine'),
};

// ---- build the stubs if they are missing ------------------------------------
function build(source, output) {
  if (existsSync(output)) return true;
  const gcc = isWindows ? 'gcc' : 'cc';
  const r = spawnSync(gcc, ['-O1', '-o', output, join(here, source)], { stdio: 'ignore', timeout: 120000 });
  return r.status === 0 && existsSync(output);
}

const haveNoop = build('noop-engine.c', stubs.noop);
const haveFailing = build('fail-engine.c', stubs.failing);
const haveWarning = build('warn-engine.c', stubs.warning);

let pass = 0;
let fail = 0;
const check = (label, ok, extra = '') => {
  if (ok) { pass++; console.log(`  PASS ${label}${extra ? ` -- ${extra}` : ''}`); }
  else { fail++; console.log(`  FAIL ${label}${extra ? ` -- ${extra}` : ''}`); }
};

if (!haveNoop || !haveFailing || !haveWarning) {
  console.log('SKIP: no C compiler available to build the stub engines (set up gcc/cc to run this file)');
  process.exit(0);
}

// ---- load the plugin --------------------------------------------------------
const registered = new Map();
const { apply } = await import(pathToFileURL(join(pluginDir, 'index.js')).href);
apply({ tools: { register: d => registered.set(d.name, d) }, logger: { info() {}, warn() {} } },
  { insecureTls: true, exePath: stubs.noop });
const fetchTool = registered.get('moli_fetch');

// ---- 1. the engine itself: exit 0, no output --------------------------------
console.log('1. engine behaviour');
const raw = spawnSync(stubs.noop, ['fetch', 'https://example.invalid/', '-d', 'markdown'], { encoding: 'buffer', timeout: 30000 });
check('stub exits 0', raw.status === 0, `status=${String(raw.status)}`);
check('stub prints nothing', raw.stdout.length === 0, `stdout=${String(raw.stdout.length)} bytes`);

// ---- 2. the plugin must call that a success ---------------------------------
console.log('\n2. plugin: zero-output success is not an error');
const result = await fetchTool.execute({ url: 'https://example.invalid/', dump: 'markdown', noJs: true }, {});
check('ok is true', result.ok === true, `ok=${String(result.ok)} error=${String(result.error ?? '')}`);
check('no error field', result.error === undefined);
check('no hint blaming the install', result.hint === undefined);
check('empty flag set', result.empty === true);
check('chars is 0', result.chars === 0);
check('content is an empty string', result.content === '');
check('url is echoed', result.url === 'https://example.invalid/');

// ---- 3. the rendered text must explain it -----------------------------------
console.log('\n3. render explains the empty result');
const rendered = fetchTool.output.render({}, result);
const text = rendered[0].text;
check('rendered as text', rendered[0].type === 'text');
check('says the fetch succeeded', /succeeded/u.test(text), JSON.stringify(text.slice(0, 70)));
check('does not say failed', !/failed/u.test(text));
check('points at noJs as the cause', /noJs/u.test(text));

// ---- 4. a real failure still fails -----------------------------------------
console.log('\n4. control: a non-zero exit is still a failure');
apply({ tools: { register: d => registered.set(d.name, d) }, logger: { info() {}, warn() {} } },
  { insecureTls: true, exePath: stubs.failing });
const failingTool = registered.get('moli_fetch');
const bad = await failingTool.execute({ url: 'https://example.invalid/', dump: 'markdown' }, {});
check('ok is false', bad.ok === false, `ok=${String(bad.ok)}`);
check('has an error', typeof bad.error === 'string' && bad.error.length > 0, JSON.stringify(String(bad.error).slice(0, 60)));
check('empty flag absent', bad.empty === undefined, `empty=${String(bad.empty)}`);
check('render says failed', /failed/u.test(failingTool.output.render({}, bad)[0].text));

// ---- 5. exit 0, empty stdout, but stderr speaks: still a failure -------------
console.log('\n5. control: stderr with no stdout is not an empty page');
apply({ tools: { register: d => registered.set(d.name, d) }, logger: { info() {}, warn() {} } },
  { insecureTls: true, exePath: stubs.warning });
const warnTool = registered.get('moli_fetch');
const warned = await warnTool.execute({ url: 'https://example.invalid/', dump: 'markdown' }, {});
check('ok is false', warned.ok === false, `ok=${String(warned.ok)}`);
check('empty flag absent', warned.empty === undefined, `empty=${String(warned.empty)}`);
check('the stderr text is surfaced', /nothing was extracted/u.test(String(warned.error)),
  JSON.stringify(String(warned.error).slice(0, 70)));

console.log(`\nresult: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
