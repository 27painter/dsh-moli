// Verify the `scroll` parameter, end to end, against the real engine.
//
// The point of the feature is triggering what only happens on a scroll, so the
// fixture makes content appear in a scroll handler and the test asserts that the
// dump carries it with `scroll` and does not without it. That is a property of the
// output, not of an internal call, which is what makes it worth asserting.
import { readdirSync, existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const REPO = dirname(here);

let pass = 0;
let fail = 0;
const check = (label, ok, extra = '') => {
  if (ok) { pass++; console.log(`  PASS ${label}${extra ? ` -- ${extra}` : ''}`); }
  else { fail++; console.log(`  FAIL ${label}${extra ? ` -- ${extra}` : ''}`); }
};

const { findMoli, combineEval, scrollScript } = await import(pathToFileURL(join(REPO, 'lib', 'moli.js')).href);

console.log('1. the expression builder (no engine needed)');
check('a pixel count becomes a scroll script', /scrollTo\(0, 800\)/u.test(String(scrollScript('800'))));
check('a negative count scrolls up', /scrollTo\(0, -500\)/u.test(String(scrollScript('-500'))));
check('"bottom" resolves to the document height', /scrollHeight/u.test(String(scrollScript('bottom'))));
check('"top" resolves to zero', /scrollTo\(0, 0\)/u.test(String(scrollScript('top'))));
check('no scroll yields no script', scrollScript(undefined) === undefined);
check('an empty string yields no script', scrollScript('') === undefined);
check('nonsense yields no script rather than breaking the fetch', scrollScript('sideways') === undefined);
check('scroll alone becomes the expression', /scrollTo/u.test(String(combineEval(undefined, '400'))));
check('an eval alone is passed through untouched', combineEval('document.title', undefined) === 'document.title');
const both = String(combineEval('document.title', '400'));
check('scroll runs before the caller\'s expression', both.indexOf('scrollTo') < both.indexOf('document.title'),
  both.slice(0, 70));
check('and the caller\'s value is still the result', /\(\(\) => \(document\.title\)\)\(\)$/u.test(both));

const exe = findMoli(undefined);
if (exe === undefined) {
  console.log('\nSKIP: no moli engine, so the end-to-end half cannot run');
} else {
  const registered = new Map();
  const { apply } = await import(pathToFileURL(join(REPO, 'index.js')).href);
  apply({ tools: { register: d => registered.set(d.name, d) }, logger: { info() {}, warn() {} } }, { insecureTls: true });
  const tool = registered.get('moli_fetch');
  const run = args => tool.execute({ ...args, timeoutMs: 60000 }, {});

  // Content that only exists after the first scroll event.
  const LAZY = 'data:text/html;charset=utf-8,' + encodeURIComponent(`<!doctype html>
<html><head><title>lazy</title></head><body>
<div style="height:3000px">TOP</div>
<div id="slot">STILL-EMPTY</div>
<div style="height:3000px"></div>
<script>
window.addEventListener('scroll', () => {
  document.getElementById('slot').textContent = 'LAZY-CONTENT-' + window.scrollY;
}, { once: true });
</script>
</body></html>`);

  console.log('\n2. a page that loads on scroll');
  const plain = await run({ url: LAZY, dump: 'markdown' });
  check('the fetch without scroll succeeds', plain.ok === true, String(plain.error ?? ''));
  check('and shows the placeholder, not the content', String(plain.content).includes('STILL-EMPTY')
    && !String(plain.content).includes('LAZY-CONTENT'), JSON.stringify(String(plain.content).slice(0, 60)));

  const scrolled = await run({ url: LAZY, dump: 'markdown', scroll: '1000' });
  check('the fetch with scroll succeeds', scrolled.ok === true, String(scrolled.error ?? ''));
  check('and the content the scroll handler wrote is now in the dump',
    String(scrolled.content).includes('LAZY-CONTENT'), JSON.stringify(String(scrolled.content).slice(0, 80)));
  check('it records where it scrolled to', /LAZY-CONTENT-1000/u.test(String(scrolled.content)),
    JSON.stringify((String(scrolled.content).match(/LAZY-CONTENT-\d+/u) ?? ['(none)'])[0]));
  check('the two dumps really differ', plain.content !== scrolled.content);

  console.log('\n3. scroll combined with eval keeps the caller\'s value');
  const withEval = await run({ url: LAZY, eval: 'document.getElementById("slot").textContent', scroll: '1200' });
  check('the expression ran after the scroll', withEval.ok === true, String(withEval.error ?? ''));
  check('and returned the scrolled state, not the placeholder',
    /LAZY-CONTENT/u.test(String(withEval.content ?? withEval.value ?? '')),
    JSON.stringify(String(withEval.content ?? withEval.value ?? '').slice(0, 60)));

  console.log('\n4. "bottom" and a screenshot');
  const bottom = await run({ url: LAZY, dump: 'markdown', scroll: 'bottom' });
  check('"bottom" triggers the scroll handler too', String(bottom.content).includes('LAZY-CONTENT'),
    JSON.stringify(String(bottom.content).slice(0, 60)));

  const dir = mkdtempSync(join(tmpdir(), 'dsh-scroll-'));
  const shotA = join(dir, 'a.png');
  const shotB = join(dir, 'b.png');
  const a = await run({ url: LAZY, dump: 'screenshot', writeTo: shotA });
  const b = await run({ url: LAZY, dump: 'screenshot', writeTo: shotB, scroll: '2000' });
  check('both screenshots were written', a.ok === true && b.ok === true && existsSync(shotA) && existsSync(shotB),
    `${String(a.error ?? '')} ${String(b.error ?? '')}`);
  if (existsSync(shotA) && existsSync(shotB)) {
    const { readFileSync } = await import('node:fs');
    const bytesA = readFileSync(shotA);
    const bytesB = readFileSync(shotB);
    check('the scrolled screenshot is a different image', !bytesA.equals(bytesB),
      `${String(bytesA.length)} vs ${String(bytesB.length)} bytes`);
  }
}

console.log(`\nresult: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
