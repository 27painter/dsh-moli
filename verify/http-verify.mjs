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

// The URL is caller input. Without `--` a value beginning with `-` is parsed as an
// option, so a caller passing a user-supplied URL can inject engine flags -- and
// even the benign case fails with a confusing "unexpected argument". Issue #6.
console.log('\n1b. the URL is a positional argument, after --');
const plain = buildArgs({ url: 'https://x/', dump: 'markdown' });
check('ends with -- then the url', plain.at(-2) === '--' && plain.at(-1) === 'https://x/',
  plain.join(' '));
check('the url is the only positional', plain.filter(t => !t.startsWith('-') && t !== 'fetch' && t !== 'markdown').length === 1);
const hostile = buildArgs({ url: '--https-proxy=http://attacker:8080', dump: 'markdown' });
check('a url starting with - is still positional',
  hostile.at(-2) === '--' && hostile.at(-1) === '--https-proxy=http://attacker:8080', hostile.join(' '));
check('and did not turn into a flag', !hostile.includes('--https-proxy'));
const shaped = buildArgs({ url: '-o/tmp/x' });
check('an -o-shaped url is not an output flag', shaped.at(-1) === '-o/tmp/x' && shaped.includes('--'),
  shaped.join(' '));

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
apply({ tools: { register: d => registered.set(d.name, d) }, logger: { info() {}, warn() {} }, on() {}, get: () => null }, { insecureTls: true });
const tool = registered.get('moli_fetch');
check('all four are declared', ['failOnHttpError', 'waitResponseUrl', 'waitResponseJson', 'waitScript']
  .every(k => tool.parameters.properties[k] !== undefined));
check('failOnHttpError is a boolean', tool.parameters.properties.failOnHttpError?.type === 'boolean');
check('the waits are strings', ['waitResponseUrl', 'waitResponseJson', 'waitScript']
  .every(k => tool.parameters.properties[k]?.type === 'string'));
check('none is required', (tool.parameters.required ?? []).length === 1 && tool.parameters.required[0] === 'url');
check('the output schema declares httpError', tool.output.schema.properties.httpError?.type === 'boolean');
check('the output schema declares evalDiscarded', tool.output.schema.properties.evalDiscarded?.type === 'boolean');

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

    // `eval` together with `dump` discards the expression value. That is the engine's
    // documented behaviour and stays, because mutating a page before capturing it is
    // a real use -- but the result used to look like a clean answer to a question
    // that was never answered, so it now says what happened.
    console.log('\n6. eval + dump says the expression value was dropped');
    const ed = await run({ url: 'https://example.com/', dump: 'markdown', eval: 'JSON.stringify({probe:1})' });
    check('still succeeds', ed.ok === true, String(ed.error ?? ''));
    check('flagged as a discarded expression', ed.evalDiscarded === true, String(ed.evalDiscarded));
    check('the note explains it', /discards the expression result/u.test(String(ed.note)),
      JSON.stringify(String(ed.note).slice(0, 70)));
    const rendered = String(tool.output.render({}, ed).text ?? tool.output.render({}, ed)[0].text);
    check('the warning is rendered first, where the body cannot bury it',
      rendered.startsWith('Note: the `eval` expression was dropped'),
      JSON.stringify(rendered.slice(0, 70)));

    const evalOnly = await run({ url: 'https://example.com/', eval: 'document.title' });
    check('eval alone returns its value', String(evalOnly.content).trim() === 'Example Domain',
      JSON.stringify(String(evalOnly.content).trim()));
    check('and is not flagged', evalOnly.evalDiscarded === undefined, String(evalOnly.evalDiscarded));

    // `scroll` alone must not replace the page with the scroll position. This is the
    // end-to-end half of the same guarantee scroll-verify asserts on combineEval.
    console.log('\n7. scroll alone still returns the page');
    const scrolled = await run({ url: 'https://example.com/', scroll: '600' });
    check('it succeeded', scrolled.ok === true, String(scrolled.error ?? ''));
    check('and returned the document, not a number', /Example Domain|<html/iu.test(String(scrolled.content)),
      JSON.stringify(String(scrolled.content).slice(0, 60)));
    check('the content is bigger than a scroll offset', String(scrolled.content).length > 100,
      `${String(String(scrolled.content).length)} chars`);

    // A wait that never resolved is the one failure that is definitely not the
    // network. It used to be reported as "the host did not answer in time, retry or
    // set a proxy", which sent the caller to check the part of the setup that was
    // working. Measured before the fix: waitSelector on an element that is not on the
    // page produced exactly that message.
    console.log('\n8. a wait that never resolves is not blamed on the network');
    for (const [label, extra, needle] of [
      ['selector', { waitSelector: '#definitely-not-here-27' }, /selector '#?\w|never matched/iu],
      ['script', { waitScript: 'window.__neverTrue === true' }, /never became truthy/iu],
      ['response', { waitResponseUrl: '/never-requested-27' }, /response matching that condition/iu],
    ]) {
      const waited = await run({ url: 'https://example.com/', timeoutMs: 8000, ...extra });
      check(`${label} wait times out`, waited.ok === false, `ok=${String(waited.ok)}`);
      check(`${label}: flagged as a condition timeout`, waited.conditionTimedOut === true,
        `conditionTimedOut=${String(waited.conditionTimedOut)}`);
      check(`${label}: not reported as unreachable`, waited.possiblyUnreachable === false,
        `possiblyUnreachable=${String(waited.possiblyUnreachable)}`);
      check(`${label}: the hint says it is not a network problem`, /not a network problem/iu.test(String(waited.hint)),
        JSON.stringify(String(waited.hint).slice(0, 60)));
      check(`${label}: the hint names the wait`, needle.test(String(waited.hint)));
    }

    // The counterpart: a real connection timeout must keep its network verdict, or
    // the fix would have traded one wrong attribution for another.
    console.log('\n9. a real connection timeout keeps its network verdict');
    const blackhole = await run({ url: 'http://10.255.255.1/', timeoutMs: 8000 });
    check('it failed', blackhole.ok === false, `ok=${String(blackhole.ok)}`);
    check('still classified as possibly unreachable', blackhole.possiblyUnreachable === true,
      `possiblyUnreachable=${String(blackhole.possiblyUnreachable)}`);
    check('not classified as a condition timeout', blackhole.conditionTimedOut === undefined,
      String(blackhole.conditionTimedOut));
    check('the hint is about the host', /host did not answer/iu.test(String(blackhole.hint)),
      JSON.stringify(String(blackhole.hint).slice(0, 60)));
  }
}

console.log(`\nresult: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
