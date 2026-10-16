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
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const REPO = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/u, '$1');
const dshRoot = join(process.env.APPDATA ?? '', 'npm', 'node_modules', '@deepseek-ai', 'dsh');
const toolsEntry = join(dshRoot, 'node_modules', '@deepseek-ai', 'dsh-tools', 'lib', 'index.js');
if (!existsSync(toolsEntry)) throw new Error(`dsh-tools not found at ${toolsEntry}`);

const { assertSupportedJsonSchema, validateJsonSchemaValue } = await import(pathToFileURL(toolsEntry).href);

const registered = new Map();
const { apply } = await import(pathToFileURL(join(REPO, 'index.js')).href);
apply({ tools: { register: d => registered.set(d.name, d) }, logger: { info() {}, warn() {} } },
  { insecureTls: true });
const fetchTool = registered.get('moli_fetch');
const probeTool = registered.get('moli_probe');

let pass = 0;
let fail = 0;
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

console.log('\n7. probe states what httpsOk covers');
const probed = await probeTool.execute({ action: 'inspect' }, {});
check('engine installed', probed.installed === true);
check('httpsOk reported', typeof probed.httpsOk === 'boolean');
check('httpsOkScope names the host process', /DSH host process/u.test(String(probed.httpsOkScope)),
  JSON.stringify(String(probed.httpsOkScope).slice(0, 70)));

console.log(`\nresult: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
