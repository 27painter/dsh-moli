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
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const dshRoot = join(process.env.APPDATA, 'npm', 'node_modules', '@deepseek-ai', 'dsh');
const toolsEntry = join(dshRoot, 'node_modules', '@deepseek-ai', 'dsh-tools', 'lib', 'index.js');
if (!existsSync(toolsEntry)) throw new Error(`dsh-tools not found at ${toolsEntry}`);

const { assertSupportedJsonSchema, validateArgs, defineTool } = await import(pathToFileURL(toolsEntry).href);

const pluginDir = process.argv[2] ?? 'D:/dsh_plugins/dsh-moli';
const registered = new Map();
const { apply } = await import(pathToFileURL(join(pluginDir, 'index.js')).href);
apply({ tools: { register: d => registered.set(d.name, d) }, logger: { info() {}, warn() {} } },
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
  const declared = Array.isArray(p.required) ? p.required : [];
  if (declared.length > 0) {
    const missing = validateArgs(p, {});
    check(`declared required (${declared.join(',')}) is enforced`, missing.length > 0, JSON.stringify(missing).slice(0, 80));
    const good = validateArgs(p, Object.fromEntries(declared.map(k => [k, k === 'url' ? 'https://example.com' : 'x'])));
    check('a call supplying them passes argument validation', good.length === 0, JSON.stringify(good).slice(0, 80));
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
