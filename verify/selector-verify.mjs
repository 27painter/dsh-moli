// Verify the `selector` parameter: read one container instead of the whole page.
//
// The two failure modes worth pinning are the ones the report named as easy to get
// wrong silently: a selector that matches nothing must not come back as empty
// content, and multiple matches need defined behaviour. Both are asserted against a
// data: URL so the shape of the page is the test's, not a website's.
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Derive the repo root from this file's location. A hard-coded absolute path works
// on the machine that wrote it and fails everywhere else -- which is exactly what
// happened: this suite passed locally and broke all three CI runners with a path
// that began with a Windows drive letter on Linux.
const REPO = dirname(dirname(fileURLToPath(import.meta.url)));

let pass = 0;
let fail = 0;
const check = (label, ok, extra = '') => {
  if (ok) { pass++; console.log(`  PASS ${label}${extra ? ` -- ${extra}` : ''}`); }
  else { fail++; console.log(`  FAIL ${label}${extra ? ` -- ${extra}` : ''}`); }
};

const { selectorScript, combineEval, buildArgs, findMoli } = await import(pathToFileURL(`${REPO}/lib/moli.js`).href);

console.log('1. the expression builder (no engine, no page)');
const script = String(selectorScript('div.card'));
check('quotes the selector as data, not code', script.includes('"div.card"'), script.slice(0, 80));
check('a selector with quotes cannot break out', String(selectorScript('a[x="1"]')).includes('"a[x=\\"1\\"]"'),
  String(selectorScript('a[x="1"]')).slice(0, 90));
check('queries all matches, not the first', /querySelectorAll/u.test(script));
check('carries a sentinel so an empty answer is distinguishable', script.includes('[dsh-moli:selector]'));
check('reports the match count', /matched:/u.test(script));
// `innerText ?? textContent` is not enough: `??` treats '' as a value. Measured on
// Bing, ten matched elements had an innerText of '' and 150-240 characters of
// textContent, and the selector reported "matched 10 but none has any text".
check('falls back to textContent when innerText is EMPTY, not only when absent',
  /inner !== ''/u.test(script) && /textContent/u.test(script), script.slice(0, 60));
check('the bare nullish fallback is gone', !/innerText \?\? node\.textContent/u.test(script));
check('no selector yields no script', selectorScript(undefined) === undefined);
check('an empty selector yields no script', selectorScript('   ') === undefined);

console.log('\n2. combining with scroll and eval (the rules)');
check('a selector alone is the expression', /dsh-moli:selector/u.test(String(combineEval(undefined, undefined, false, 'p'))));
const withScroll = String(combineEval(undefined, '500', false, 'p'));
check('scroll runs before the selector', withScroll.indexOf('scrollTo') < withScroll.indexOf('dsh-moli:selector'),
  withScroll.slice(0, 60));
check('a selector with a dump is still passed for its side effect',
  /dsh-moli:selector/u.test(String(combineEval(undefined, '500', true, 'p'))));
check('nothing at all yields undefined', combineEval(undefined, undefined, false, undefined) === undefined);

console.log('\n3. buildArgs never emits two readers');
const argv = buildArgs({ url: 'https://x/', selector: 'p' });
const evalAt = argv.indexOf('--eval');
check('the selector reaches --eval', evalAt >= 0 && /dsh-moli:selector/u.test(argv[evalAt + 1]),
  evalAt >= 0 ? String(argv[evalAt + 1]).slice(0, 50) : 'no --eval');
check('no -d is emitted for a selector call', !argv.includes('-d'));

const exe = findMoli(undefined);
if (exe === undefined) {
  console.log('\nSKIP: no moli engine, so the end-to-end half cannot run');
} else {
  const registered = new Map();
  const { apply } = await import(pathToFileURL(`${REPO}/index.js`).href);
  apply({ tools: { register: d => registered.set(d.name, d) }, logger: { info() {}, warn() {} }, on() {}, get: () => null },
    { insecureTls: true });
  const tool = registered.get('moli_fetch');
  const run = args => tool.execute({ ...args, timeoutMs: args.timeoutMs ?? 60000 }, {});
  const render = value => String(tool.output.render({}, value)[0].text);

  // A fixture whose element count and text are known, so a wrong answer is visible.
  const PAGE = 'data:text/html;charset=utf-8,' + encodeURIComponent(`<!doctype html>
<html><head><title>sel</title></head><body>
  <div class="card"><span class="title">CARD-ONE</span></div>
  <div class="card"><span class="title">CARD-TWO</span></div>
  <div class="card"><span class="title">CARD-THREE</span></div>
  <div class="icon"><img src="data:," alt=""></div>
  <div style="height:3000px"></div>
  <div class="card"><span class="title">CARD-FOUR</span></div>
</body></html>`);

  console.log('\n4. one container, several matches');
  const cards = await run({ url: PAGE, selector: '.card' });
  check('succeeded', cards.ok === true, String(cards.error ?? ''));
  check('reports the match count', cards.matched === 4, `matched=${String(cards.matched)}`);
  check('all four texts are present', ['CARD-ONE', 'CARD-TWO', 'CARD-THREE', 'CARD-FOUR']
    .every(t => String(cards.content).includes(t)), JSON.stringify(String(cards.content).slice(0, 60)));
  check('joined with newlines', String(cards.content).split('\n').length >= 4);
  check('much smaller than the page', String(cards.content).length < 200,
    `${String(String(cards.content).length)} chars`);
  check('the render names the count', /matched 4 element/u.test(render(cards)), JSON.stringify(render(cards).slice(0, 60)));

  console.log('\n5. matching nothing is an error, not empty content');
  const nothing = await run({ url: PAGE, selector: '.no-such-thing' });
  check('not reported as success', nothing.ok === false, `ok=${String(nothing.ok)}`);
  check('says no element matches', /no element matches/u.test(String(nothing.error)),
    JSON.stringify(String(nothing.error).slice(0, 60)));
  check('matched is zero', nothing.matched === 0, String(nothing.matched));
  check('suggests what to do', /waitSelector|dump/u.test(String(nothing.hint)));
  check('the render does not print "undefined"', !/undefined/u.test(render(nothing)), JSON.stringify(render(nothing).slice(0, 80)));

  console.log('\n6. matching a textless element is reported as such');
  const icon = await run({ url: PAGE, selector: '.icon' });
  check('not reported as a silent success', icon.ok === false, `ok=${String(icon.ok)}`);
  check('explains that the element has no text', /none of them has any text/u.test(String(icon.error)),
    JSON.stringify(String(icon.error).slice(0, 70)));

  console.log('\n7. the two combinations that would silently drop something');
  const withDump = await run({ url: PAGE, selector: '.card', dump: 'markdown' });
  check('selector + dump is refused', withDump.ok === false, `ok=${String(withDump.ok)}`);
  check('and says which one to drop', /cannot be combined/u.test(String(withDump.error)),
    JSON.stringify(String(withDump.error).slice(0, 70)));
  check('the dump was not quietly returned instead', withDump.content === undefined, String(withDump.content));

  const withEval2 = await run({ url: PAGE, selector: '.card', eval: 'document.title' });
  check('selector + eval is refused', withEval2.ok === false, `ok=${String(withEval2.ok)}`);
  check('and says only one value can be returned', /only one expression value/u.test(String(withEval2.error)),
    JSON.stringify(String(withEval2.error).slice(0, 70)));

  console.log('\n8. selector composes with scroll');
  const scrolled = await run({ url: PAGE, selector: '.card', scroll: '2000' });
  check('succeeded', scrolled.ok === true, String(scrolled.error ?? ''));
  check('still found all four cards', scrolled.matched === 4, `matched=${String(scrolled.matched)}`);
}

console.log(`\nresult: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
