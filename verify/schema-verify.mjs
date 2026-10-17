// Validate the plugin's tool definitions with the REGISTRY'S OWN validator.
//
// This is the test that was missing twice over. Every earlier test used a fake
// `ctx.tools` whose `register` only stored the definition, so nothing the real
// registry or the model provider checks was ever exercised. Two shipping failures
// came out of that hole:
//
//   1. a raw output schema using the property-level `required: true` form ->
//      `JsonSchemaError` at registration, so the plugin never activated
//   2. parameters left in the author DSL -> `schemaOf` projects them to the
//      provider verbatim -> `schema must be a JSON Schema of 'type: "object"',
//      got 'type: null'`
//
// Both layers must therefore be RAW JSON Schema, because this plugin registers
// plain definitions instead of going through `defineTool`.
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/**
 * Run `npm root -g` and return the global modules directory.
 *
 * npm is invoked through the current Node binary rather than as `npm`/`npm.cmd`:
 * Node 20+ refuses to spawn a `.cmd` without `shell: true` (it fails with EINVAL,
 * which is what broke the Windows CI job), and `shell: true` concatenates
 * arguments without escaping. Running npm's own cli.js under this Node process
 * avoids both. `npm_execpath` is set when npm script runs us; otherwise the
 * expected location under the Node install is used.
 */
function npmGlobalRoot() {
  // `process.execPath` is the running Node, so npm lives beside it. Computing the
  // path this way works for a system install, nvm, and actions/setup-node, where
  // the npm package sits under the same prefix as the node binary.
  const besideNode = join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
  const cliCandidates = [
    process.env.npm_execpath,
    besideNode,
    join(process.env.APPDATA ?? '', 'npm', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    'C:\\npm\\prefix\\node_modules\\npm\\bin\\npm-cli.js',
    join(process.env.ProgramFiles ?? 'C:\\Program Files', 'nodejs', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
  ].filter(p => typeof p === 'string' && p !== '' && existsSync(p));

  for (const cli of cliCandidates) {
    const r = spawnSync(process.execPath, [cli, 'root', '-g'], { encoding: 'utf8', timeout: 60000 });
    const out = String(r.stdout ?? '').trim();
    if (r.status === 0 && out !== '') return { root: out };
  }

  // Last resort: the platform launcher, which is only spawnable where Node still
  // permits a `.cmd` to be executed directly.
  const r = spawnSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['root', '-g'],
    { encoding: 'utf8', timeout: 60000 });
  const out = String(r.stdout ?? '').trim();
  if (r.status === 0 && out !== '') return { root: out };
  return {
    error: `${String(r.error?.code ?? r.status ?? 'no output')}`
      + (cliCandidates.length === 0 ? ` (no npm cli.js found; looked for ${besideNode})` : ''),
  };
}

/**
 * Locate the npm-global `@deepseek-ai/dsh` package.
 *
 * Ask npm where its global modules live instead of deriving it. Two earlier
 * attempts failed in CI: a candidate list missed the tree because
 * `actions/setup-node` relocates the global prefix (`npm install -g` reported
 * "added 540 packages" while `/usr/local/lib` stayed empty), and building the
 * path from `npm prefix -g` was wrong there too. `npm root -g` answers with the
 * modules directory directly, and on Windows CI it correctly reported
 * `C:\npm\prefix\node_modules` -- the failure there was only how npm was spawned.
 * The list below is a fallback for when npm cannot be run at all.
 */
function findDshRoot() {
  const tried = [];
  const looksRight = p => existsSync(join(p, 'package.json'));

  const { root, error } = npmGlobalRoot();
  if (root !== undefined) {
    const candidate = join(root, '@deepseek-ai', 'dsh');
    tried.push(`${candidate}  (from \`npm root -g\`)`);
    if (looksRight(candidate)) return candidate;
  } else {
    tried.push(`\`npm root -g\` failed: ${String(error)}`);
  }

  const fallbacks = process.platform === 'win32'
    ? [
        join(process.env.APPDATA ?? '', 'npm', 'node_modules', '@deepseek-ai', 'dsh'),
        join('C:\\npm\\prefix', 'node_modules', '@deepseek-ai', 'dsh'),
      ]
    : [
        '/usr/local/lib/node_modules/@deepseek-ai/dsh',
        '/opt/homebrew/lib/node_modules/@deepseek-ai/dsh',
        '/usr/lib/node_modules/@deepseek-ai/dsh',
        join(process.env.HOME ?? '', '.local', 'lib', 'node_modules', '@deepseek-ai', 'dsh'),
        join(process.env.HOME ?? '', '.npm-global', 'lib', 'node_modules', '@deepseek-ai', 'dsh'),
        join(process.env.HOME ?? '', 'node_modules', '@deepseek-ai', 'dsh'),
      ];
  for (const p of fallbacks) {
    tried.push(p);
    if (looksRight(p)) return p;
  }

  throw new Error(
    'the npm-global @deepseek-ai/dsh package was not found. Tried:\n  ' + tried.join('\n  ') +
    '\nInstall it with: npm install -g @deepseek-ai/dsh, then run this verify again.'
  );
}

const dshRoot = findDshRoot();
const toolsEntry = join(dshRoot, 'node_modules', '@deepseek-ai', 'dsh-tools', 'lib', 'index.js');
if (!existsSync(toolsEntry)) throw new Error(`dsh-tools not found at ${toolsEntry}`);

const { assertSupportedJsonSchema, validateJsonSchemaValue, defineTool } = await import(pathToFileURL(toolsEntry).href);

// The default plugin dir is the workspace root (this file lives in verify/).
// argv[2] still overrides it, e.g. to point at an installed copy. No platform
// keeps a hardcoded install path as the default: a schema-verify run validates
// the working tree it lives in, and hosts that target an installed copy pass it
// explicitly.
const here = dirname(fileURLToPath(import.meta.url));
const pluginDir = process.argv[2] ?? dirname(here);
const registered = new Map();
const { apply } = await import(pathToFileURL(join(pluginDir, 'index.js')).href);
apply({ tools: { register: d => registered.set(d.name, d) }, logger: { info() {}, warn() {} }, on() {}, get: () => null },
  { insecureTls: true, proxy: 'http://127.0.0.1:7890' });

let pass = 0;
let fail = 0;
const check = (label, ok, extra = '') => {
  if (ok) { pass++; console.log(`  PASS ${label}${extra ? ' -- ' + extra : ''}`); }
  else { fail++; console.log(`  FAIL ${label}${extra ? ' -- ' + extra : ''}`); }
};
const trySchema = schema => {
  try { assertSupportedJsonSchema(schema); return { ok: true }; }
  catch (error) { return { ok: false, message: String(error.message) }; }
};

console.log(`plugin dir : ${pluginDir}`);
console.log(`validator  : ${toolsEntry}`);
console.log(`registered : ${[...registered.keys()].join(', ')}\n`);

for (const [name, def] of registered) {
  console.log(`=== ${name} ===`);

  // The provider receives definition.parameters verbatim, so these are the checks
  // that matter: a raw object root, and acceptance by the registry validator.
  const p = def.parameters;
  check('parameters is an object', typeof p === 'object' && p !== null && !Array.isArray(p));
  check('parameters.type is "object"', p.type === 'object', `got ${JSON.stringify(p.type)}`);
  check('parameters carries no DSL artefact', !JSON.stringify(p).includes('"required":true'));
  const pr = trySchema(p);
  check('parameters passes the registry validator', pr.ok, pr.ok ? '' : String(pr.message).slice(0, 160));

  const or = trySchema(def.output.schema);
  check('output schema passes the registry validator', or.ok, or.ok ? '' : String(or.message).slice(0, 200));
  check('output schema type is "object"', def.output.schema.type === 'object');

  // Required semantics must still be enforced where they are declared.
  //
  // `validateArgs` is NOT the runtime path: it converts its argument with the author
  // DSL compiler first, so it only accepts a DSL spec and throws on a raw schema.
  // Runtime argument validation is `validateJsonSchemaValue(parameters, args)` —
  // see `defineTool`'s own `const validate = (args) => validateJsonSchemaValue(...)`.
  // Using the wrong one here produced a false alarm about a contradiction that does
  // not exist.
  const declared = Array.isArray(p.required) ? p.required : [];
  if (declared.length > 0) {
    // Build a value that actually satisfies each declaration. An enum member has to
    // be one of its values: supplying the literal 'x' for every required field made
    // a required enum fail validation, which was a defect in this probe rather than
    // in the schema. `oneOf`/`anyOf` are not used by these tools; if one appears,
    // its first branch is tried.
    const sampleFor = (name, schema) => {
      let s = schema ?? {};
      if (Array.isArray(s.oneOf) && s.oneOf.length > 0) s = s.oneOf[0];
      if (Array.isArray(s.anyOf) && s.anyOf.length > 0) s = s.anyOf[0];
      if (Array.isArray(s.enum) && s.enum.length > 0) return s.enum[0];
      if (s.type === 'string') return name === 'url' ? 'https://example.com' : 'x';
      if (s.type === 'integer' || s.type === 'number') return 1;
      if (s.type === 'boolean') return true;
      if (s.type === 'array') return [];
      return 'x';
    };
    const goodArgs = Object.fromEntries(declared.map(k => [k, sampleFor(k, (p.properties ?? {})[k])]));

    const missing = validateJsonSchemaValue(p, {});
    check(`declared required (${declared.join(',')}) is enforced`, missing.length > 0, JSON.stringify(missing).slice(0, 80));
    check('a call supplying them passes argument validation', validateJsonSchemaValue(p, goodArgs).length === 0,
      JSON.stringify(validateJsonSchemaValue(p, goodArgs)).slice(0, 120));
    check(`a wrong-typed ${declared[0]} is rejected`, validateJsonSchemaValue(p, { [declared[0]]: 42 }).length > 0);

    const first = (p.properties ?? {})[declared[0]] ?? {};
    if (Array.isArray(first.enum)) {
      const bad = validateJsonSchemaValue(p, { ...goodArgs, [declared[0]]: 'not-a-member-of-this-enum' });
      check(`a ${declared[0]} outside its enum is rejected`, bad.length > 0, JSON.stringify(bad).slice(0, 80));
    }
  } else {
    check('no required parameters declared', true, '(all optional by design)');
  }
  console.log('');
}

console.log('=== control: the shapes that broke shipping must still be rejected ===');
const c1 = trySchema({ type: 'object', additionalProperties: true, properties: { ok: { type: 'boolean', required: true } } });
check('property-level required in a raw output schema is rejected', c1.ok === false, String(c1.message).slice(0, 70));
try {
  defineTool({
    name: 'c2', description: 'c2',
    parameters: { url: { type: 'string', required: true } },
    output: { schema: { type: 'object', additionalProperties: true, required: ['ok'], properties: { ok: { type: 'boolean' } } }, render: () => [] },
    execute: () => Promise.resolve({}),
  });
  check('object-level required inside defineTool is rejected', false, 'defineTool accepted it');
} catch (error) {
  check('object-level required inside defineTool is rejected', true, String(error.message).slice(0, 70));
}

console.log(`\nresult: ${pass} passed, ${fail} failed`);
process.exitCode = fail === 0 ? 0 : 1;
