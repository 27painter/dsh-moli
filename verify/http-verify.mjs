// Verify the two additions: `failOnHttpError` and the response waits.
//
// The parameter-to-flag mapping is asserted directly, because a parameter that
// never reaches the engine looks exactly like a feature that does not work. The
// end-to-end half needs an HTTP error, and loopback servers are unreachable from
// this sandbox (`curl.exe` times out on 127.0.0.1 while the Node host can reach
// it), so it uses a stable external URL and skips when the network is absent.
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';

const here = dirname(fileURLToPath(import.meta.url));
const REPO = dirname(here);

let pass = 0;
let fail = 0;
const check = (label, ok, extra = '') => {
  if (ok) { pass++; console.log(`  PASS ${label}${extra ? ` -- ${extra}` : ''}`); }
  else { fail++; console.log(`  FAIL ${label}${extra ? ` -- ${extra}` : ''}`); }
};

const { buildArgs, findMoli } = await import(pathToFileURL(join(REPO, 'lib', 'moli.js')).href);

/** The value that follows a flag in an argv vector, or undefined. */
const after = (argv, flag) => {
  const at = argv.indexOf(flag);
  return at < 0 ? undefined : argv[at + 1];
};

console.log('1. failOnHttpError maps to the engine flag, and only when asked');
check('absent by default', !buildArgs({ url: 'https://x/' }).includes('--fail-with-body'));
check('absent when false', !buildArgs({ url: 'https://x/', failOnHttpError: false }).includes('--fail-with-body'));
check('present when true', buildArgs({ url: 'https://x/', failOnHttpError: true }).includes('--fail-with-body'));
check('not the suppressing variant', !buildArgs({ url: 'https://x/', failOnHttpError: true }).includes('--fail'),
  'uses --fail-with-body, which keeps the body');

console.log('\n2. the response waits map to their flags');
const a = buildArgs({ url: 'https://x/', waitResponseUrl: '/api/list' });
check('waitResponseUrl sets --wait-response-url', after(a, '--wait-response-url') === '/api/list');
const b = buildArgs({ url: 'https://x/', waitResponseJson: 'data.list.0.id=42' });
check('waitResponseJson sets --wait-response-json', after(b, '--wait-response-json') === 'data.list.0.id=42');
const c = buildArgs({ url: 'https://x/', waitScript: 'window.ready === true' });
check('waitScript sets --wait-script', after(c, '--wait-script') === 'window.ready === true');
check('an empty string does not emit a flag', !buildArgs({ url: 'https://x/', waitResponseUrl: '' }).includes('--wait-response-url'));
check('the three coexist', ['--wait-response-url', '--wait-response-json', '--wait-script']
  .every(f => buildArgs({ url: 'https://x/', waitResponseUrl: 'a', waitResponseJson: 'b=1', waitScript: 'c' }).includes(f)));

console.log('\n3. the schema declares them');
const registered = new Map();
const { apply } = await import(pathToFileURL(join(REPO, 'index.js')).href);
apply({ tools: { register: d => registered.set(d.name, d) }, logger: { info() {}, warn() {} } }, { insecureTls: true });
const tool = registered.get('moli_fetch');
check('all four are declared', ['failOnHttpError', 'waitResponseUrl', 'waitResponseJson', 'waitScript']
  .every(k => tool.parameters.properties[k] !== undefined));
check('failOnHttpError is a boolean', tool.parameters.properties.failOnHttpError?.type === 'boolean');
check('the waits are strings', ['waitResponseUrl', 'waitResponseJson', 'waitScript']
  .every(k => tool.parameters.properties[k]?.type === 'string'));
check('none is required', (tool.parameters.required ?? []).length === 1 && tool.parameters.required[0] === 'url');
check('the output schema declares httpError', tool.output.schema.properties.httpError?.type === 'boolean');

// ---------------------------------------------------------------------------
console.log('\n4. end to end: an HTTP error is reported and its body kept');
const exe = findMoli(undefined);
if (exe === undefined) {
  console.log('  SKIP: no moli engine');
} else {
  const run = args => tool.execute({ ...args, timeoutMs: args.timeoutMs ?? 60000 }, {});
  // A path that cannot exist under a domain reserved for examples. Probed against
  // several candidates: this one answers 404 with a body every time, where a random
  // site's 404 path can be a soft-404 (HTTP 200) or an unreachable host.
  const NOT_FOUND = 'https://example.com/definitely-not-here-27painter';

  const off = await run({ url: NOT_FOUND, dump: 'markdown' });
  if (off.ok !== true && /Unable to resolve|Failed to connect|timed out|unreachable/iu.test(String(off.error))) {
    console.log(`  SKIP: the network is unavailable (${String(off.error).slice(0, 60)})`);
  } else {
    check('with the flag off the error page is ordinary content', off.ok === true, `ok=${String(off.ok)} err=${String(off.error ?? '').slice(0, 50)}`);

    const on = await run({ url: NOT_FOUND, dump: 'markdown', failOnHttpError: true });
    check('with the flag on it is a reported failure', on.ok === false, `ok=${String(on.ok)}`);
    check('flagged as an HTTP error', on.httpError === true, `httpError=${String(on.httpError)}`);
    check('the status is 404', on.status === 404, `status=${String(on.status)}`);
    check('the body is preserved rather than discarded', typeof on.content === 'string' && on.content.length > 0,
      `${String(on.content?.length ?? 0)} chars`);
    check('the rendering includes that body', String(tool.output.render({}, on)[0].text).length > 120);

    const healthy = await run({ url: 'https://example.com/', dump: 'markdown', failOnHttpError: true });
    check('a healthy page still succeeds with the flag on', healthy.ok === true, `ok=${String(healthy.ok)} ${String(healthy.error ?? '').slice(0, 50)}`);
    check('and carries no httpError flag', healthy.httpError === undefined, String(healthy.httpError));

    console.log('\n5. a binary error still writes its file and reports the failure');
    const dir = mkdtempSync(join(tmpdir(), 'dsh-httperr-'));
    const shot = join(dir, 'err.png');
    const bin = await run({ url: NOT_FOUND, dump: 'screenshot', writeTo: shot, failOnHttpError: true });
    check('reported as a failure', bin.ok === false, `ok=${String(bin.ok)}`);
    // Under `--fail-with-body` the engine still renders the error page as an image,
    // so the file is written -- and the result must not have decoded a PNG as text.
    check('the PNG was written', existsSync(shot), existsSync(shot) ? '' : String(bin.error ?? ''));
    check('it was not decoded as text', bin.chars === undefined, `chars=${String(bin.chars)}`);
    check('reported as a binary result', bin.kind === 'binary' && bin.path === shot, `kind=${String(bin.kind)}`);
    if (existsSync(shot)) {
      const magic = readFileSync(shot).subarray(0, 8).toString('hex');
      check('and it is a real PNG', magic === '89504e470d0a1a0a', magic);
    }
    check('the status is still named', bin.status === 404, `status=${String(bin.status)}`);
    check('the hint points at the file', /was written to/u.test(String(bin.hint)), JSON.stringify(String(bin.hint).slice(0, 70)));
  }
}

console.log(`\nresult: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
