// Validate the plugin's schemas with the REGISTRY'S OWN validator.
//
// This is the test that was missing. Every earlier test used a fake `ctx.tools`
// whose `register` only stored the definition, so `assertSupportedJsonSchema` never
// ran and an invalid schema shipped. A real DSH then refused to activate the plugin:
//
//   JsonSchemaError: unsupported JSON schema:
//     schema.properties.ok.required is not supported on type "boolean"
//
// Importing the registry's validator directly keeps the check honest without
// standing up a whole Host.
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const dshRoot = join(process.env.APPDATA, 'npm', 'node_modules', '@deepseek-ai', 'dsh');
const toolsEntry = join(dshRoot, 'node_modules', '@deepseek-ai', 'dsh-tools', 'lib', 'index.js');
if (!existsSync(toolsEntry)) throw new Error(`dsh-tools not found at ${toolsEntry}`);

const { assertSupportedJsonSchema, parameterSchemaSpecToJsonSchema, validateArgs, JsonSchemaError } =
  await import(pathToFileURL(toolsEntry).href);

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

/** Try the registry's validator and report what it says. */
const validate = schema => {
  try {
    assertSupportedJsonSchema(schema);
    return { ok: true };
  } catch (error) {
    return { ok: false, message: error instanceof JsonSchemaError ? error.message : String(error) };
  }
};

console.log(`plugin dir : ${pluginDir}`);
console.log(`validator  : ${toolsEntry}\n`);
console.log(`tools registered: ${[...registered.keys()].join(', ')}\n`);

for (const [name, def] of registered) {
  console.log(`=== ${name} ===`);

  // Parameters: the registry's DSL must convert, and the conversion must be valid.
  let converted;
  try {
    converted = parameterSchemaSpecToJsonSchema(def.parameters);
    check('parameter DSL converts', true);
  } catch (error) {
    check('parameter DSL converts', false, String(error.message).slice(0, 140));
  }
  if (converted !== undefined) {
    const r = validate(converted);
    check('converted parameters pass the registry validator', r.ok, r.ok ? '' : String(r.message).slice(0, 200));
    console.log(`    converted: ${JSON.stringify(converted).slice(0, 220)}`);
  }

  // The raw output schema is validated as-is by the registry.
  const r2 = validate(def.output.schema);
  check('output schema passes the registry validator', r2.ok, r2.ok ? '' : String(r2.message).slice(0, 240));

  // Reject the exact form that broke activation, to prove the check has teeth.
  const bad = validate({ type: 'object', properties: { ok: { type: 'boolean', required: true } } });
  check('  (control) property-level required is rejected', bad.ok === false, bad.ok ? 'validator accepted it!' : String(bad.message).slice(0, 90));
  console.log('');
}

console.log('=== argument validation still behaves ===');
const fetchDef = registered.get('moli_fetch');
if (fetchDef !== undefined) {
  const paramSchema = parameterSchemaSpecToJsonSchema(fetchDef.parameters);
  const good = validateArgs(fetchDef.parameters, { url: 'https://example.com' });
  check('a valid call has no violations', good.length === 0, JSON.stringify(good).slice(0, 120));
  const missing = validateArgs(fetchDef.parameters, {});
  check('a missing url is rejected', missing.length > 0, JSON.stringify(missing).slice(0, 120));
  const badType = validateArgs(fetchDef.parameters, { url: 42 });
  check('a non-string url is rejected', badType.length > 0, JSON.stringify(badType).slice(0, 120));
  check('url is still declared required', JSON.stringify(paramSchema).includes('"required"'), String(paramSchema.required ?? paramSchema.properties?.url?.required));
  const strictMissing = validateArgs(fetchDef.parameters, {});
  check('the required array survived conversion', strictMissing.length > 0, JSON.stringify(strictMissing));
}

console.log(`\nresult: ${pass} passed, ${fail} failed`);
process.exitCode = fail === 0 ? 0 : 1;
