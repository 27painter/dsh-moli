// Regression guard for the four findings that came out of the usage report:
//
//   1. eval/dump mutual exclusion was undocumented -> callers read a page dump
//      where they expected an expression value
//   2. eval failure fell through to the generic "run moli_probe" hint, which
//      cannot help when the expression is what threw
//   3. truncation kept only the head, so a nav-heavy page could fill the whole
//      budget with chrome and return none of the content
//   4. `proxy` was configurable in the profile but not per call
//
// Plus the scope note on `moli_probe`'s httpsOk, which reads as "this machine has
// internet" when it only describes the host process.
//
// Network-dependent checks are kept to pages that are stable and small; the
// pure-shape checks run without a network at all so a sandboxed runner still
// exercises them.
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Same rule as schema-verify.mjs: ask npm where its global modules live rather
// than assuming %APPDATA%\npm or /usr/local/lib, because installers -- nvm,
// Homebrew, actions/setup-node -- relocate the prefix. npm runs through the
// current Node binary: Node 20+ refuses to spawn a bare `.cmd` (EINVAL, which is
// what broke the Windows CI job) and `shell: true` does not escape arguments.
function npmGlobalRoot() {
  // npm lives beside the running node binary, which covers a system install, nvm
  // and actions/setup-node alike.
  const besideNode = join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
  const clis = [
    process.env.npm_execpath,
    besideNode,
    join(process.env.APPDATA ?? '', 'npm', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    'C:\\npm\\prefix\\node_modules\\npm\\bin\\npm-cli.js',
  ].filter(p => typeof p === 'string' && p !== '' && existsSync(p));
  for (const cli of clis) {
    const r = spawnSync(process.execPath, [cli, 'root', '-g'], { encoding: 'utf8', timeout: 60000 });
    const out = String(r.stdout ?? '').trim();
    if (r.status === 0 && out !== '') return out;
  }
  const r = spawnSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['root', '-g'],
    { encoding: 'utf8', timeout: 60000 });
  const out = String(r.stdout ?? '').trim();
  return r.status === 0 && out !== '' ? out : undefined;
}

function findDshRoot() {
  const root = npmGlobalRoot();
  const candidates = [];
  if (root !== undefined) candidates.push(join(root, '@deepseek-ai', 'dsh'));
  if (process.platform === 'win32') {
    candidates.push(
      join(process.env.APPDATA ?? '', 'npm', 'node_modules', '@deepseek-ai', 'dsh'),
      'C:\\npm\\prefix\\node_modules\\@deepseek-ai\\dsh',
    );
  } else {
    candidates.push(
      '/usr/local/lib/node_modules/@deepseek-ai/dsh',
      '/opt/homebrew/lib/node_modules/@deepseek-ai/dsh',
      join(process.env.HOME ?? '', '.local', 'lib', 'node_modules', '@deepseek-ai', 'dsh'),
    );
  }
  const found = candidates.find(p => existsSync(join(p, 'package.json')));
  if (found === undefined) {
    throw new Error('npm-global @deepseek-ai/dsh not found. Tried:\n  ' + candidates.join('\n  ')
      + '\nInstall it with: npm install -g @deepseek-ai/dsh');
  }
  return found;
}

const here = dirname(fileURLToPath(import.meta.url));
const REPO = dirname(here);
const dshRoot = findDshRoot();
const toolsEntry = join(dshRoot, 'node_modules', '@deepseek-ai', 'dsh-tools', 'lib', 'index.js');
if (!existsSync(toolsEntry)) throw new Error(`dsh-tools not found at ${toolsEntry}`);

const { assertSupportedJsonSchema, validateJsonSchemaValue } = await import(pathToFileURL(toolsEntry).href);

// The network groups (4-6) and the probe group (7) drive a real engine: without
// one every call fails with "moli was not found". Probe for the engine up front
// (same check as http-verify) and skip those groups cleanly when it is absent,
// so the suite still passes on a host where the engine was uninstalled.
const { findMoli } = await import(pathToFileURL(join(REPO, 'lib', 'moli.js')).href);
const engineExe = findMoli(undefined);

const registered = new Map();
const { apply } = await import(pathToFileURL(join(REPO, 'index.js')).href);
apply({ tools: { register: d => registered.set(d.name, d) }, logger: { info() {}, warn() {} }, on() {}, get: () => null },
  { insecureTls: true });
const fetchTool = registered.get('moli_fetch');
const probeTool = registered.get('moli_probe');

let pass = 0;
let fail = 0;
let skipped = 0;
const check = (label, ok, extra = '') => {
  if (ok) { pass++; console.log(`  PASS ${label}${extra ? ` -- ${extra}` : ''}`); }
  else { fail++; console.log(`  FAIL ${label}${extra ? ` -- ${extra}` : ''}`); }
};

console.log('1. schemas still satisfy the registry validator (offline)');
for (const [name, def] of registered) {
  let verdict = 'ok';
  try {
    assertSupportedJsonSchema(def.parameters);
    assertSupportedJsonSchema(def.output.schema);
  } catch (error) { verdict = String(error.message); }
  check(`${name}: parameters and output schema accepted`, verdict === 'ok', verdict.slice(0, 80));
}
check('moli_fetch output declares omitted', fetchTool.output.schema.properties.omitted?.type === 'integer');
check('moli_fetch output declares evalFailed', fetchTool.output.schema.properties.evalFailed?.type === 'boolean');
check('moli_probe output declares httpsOkScope', probeTool.output.schema.properties.httpsOkScope?.type === 'string');

console.log('\n2. proxy is a per-call parameter (offline)');
const props = fetchTool.parameters.properties;
check('proxy declared as a string', props.proxy?.type === 'string');
check('proxy is optional', !(fetchTool.parameters.required ?? []).includes('proxy'));
const validated = validateJsonSchemaValue(fetchTool.parameters,
  { url: 'https://example.com/', proxy: 'http://127.0.0.1:7890' });
check('a call carrying proxy validates', validated === undefined || validated?.ok !== false,
  JSON.stringify(validated ?? null).slice(0, 60));

console.log('\n3. eval documents the dump interaction (offline)');
check('eval description mentions discarding the value', /discard/u.test(props.eval.description));

// ---- network-dependent behaviour -------------------------------------------
// Groups 4-6 need the open internet (example.com, bbs.nga.cn) and group 7 needs
// a real engine. Like http-verify, probe up front and skip cleanly when the
// engine or the network is absent, so an offline or engine-less runner reports
// a clean skip instead of false failures.
if (engineExe === undefined) {
  skipped += 10;
  console.log('  SKIP: no moli engine; groups 4-7 skipped');
} else {
console.log('\n4-6. network-dependent checks');
const probe = await fetchTool.execute({ url: 'https://example.com/', dump: 'markdown', timeoutMs: 45000 }, {});
if (probe.ok !== true && /Unable to resolve|Failed to connect|timed out|unreachable|ENOTFOUND|EAI_AGAIN/iu.test(String(probe.error))) {
  skipped += 7;
  console.log(`  SKIP: the network is unavailable (${String(probe.error).slice(0, 60)}); groups 4-6 skipped`);
} else {
console.log('\n4. eval failure is classified as an expression error');
const thrown = await fetchTool.execute({ url: 'https://example.com/', eval: 'null.missing', timeoutMs: 45000 }, {});
if (thrown.ok === false && /JavaScript evaluation failed/u.test(String(thrown.error))) {
  check('evalFailed is set', thrown.evalFailed === true);
  check('hint is about the expression', /expression threw/u.test(String(thrown.hint)));
  check('hint does not send the caller to moli_probe', !/Run moli_probe/u.test(String(thrown.hint)));
  check('engine error preserved', /TypeError|SyntaxError|ReferenceError/u.test(String(thrown.error)));
} else {
  check('engine reported an eval failure to classify', false,
    `ok=${String(thrown.ok)} err=${JSON.stringify(String(thrown.error ?? '').slice(0, 80))}`);
}

console.log('\n5. truncation keeps the tail as well as the head');
const long = await fetchTool.execute({ url: 'https://bbs.nga.cn/thread.php?key=test', maxChars: 300, timeoutMs: 45000 }, {});
if (long.ok === true && long.truncated === true) {
  check('omitted count reported', typeof long.omitted === 'number' && long.omitted > 0, `omitted=${String(long.omitted)}`);
  const at = String(long.content).indexOf('characters omitted here');
  check('marker present', at > 0);
  check('marker is between head and tail', at > 0 && at < String(long.content).length - 20, `at ${String(at)}`);
  check('note describes head and tail', /first .* and the last /u.test(String(long.note)));
} else {
  check('reached a page long enough to truncate', false,
    `ok=${String(long.ok)} truncated=${String(long.truncated)} chars=${String(long.chars)}`);
}

console.log('\n6. a short page is left alone');
const short = await fetchTool.execute({ url: 'https://example.com/', dump: 'markdown', timeoutMs: 45000 }, {});
if (short.ok === true) {
  check('not truncated', short.truncated === false, `chars=${String(short.chars)}`);
  check('no omitted field', short.omitted === undefined);
  check('no marker in content', !/characters omitted here/u.test(String(short.content)));
} else {
  check('short page fetched', false, JSON.stringify(String(short.error ?? '').slice(0, 70)));
}
} // end network-available else (groups 4-6)

console.log('\n7. probe states what httpsOk covers');
const probed = await probeTool.execute({ action: 'inspect' }, {});
check('engine installed', probed.installed === true);
check('httpsOk reported', typeof probed.httpsOk === 'boolean');
check('httpsOkScope names the host process', /DSH host process/u.test(String(probed.httpsOkScope)),
  JSON.stringify(String(probed.httpsOkScope).slice(0, 70)));
} // end engine-available else (groups 4-7)

console.log(`\nresult: ${pass} passed, ${fail} failed${skipped ? `, ${skipped} skipped` : ''}`);
process.exit(fail === 0 ? 0 : 1);
