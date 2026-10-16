// End-to-end verification of moli_session.
//
// Everything runs against a `data:` URL fixture served from the page itself, so
// the suite needs no network and cannot be broken by a site changing underneath
// it. The one thing it does need is a real moli engine and Node's built-in
// WebSocket, and it says so plainly instead of failing obscurely.
//
// The session is a long-lived child process, unlike every other child this plugin
// spawns, so the last check is that `close` actually stops it and frees the port.
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createConnection } from 'node:net';

const here = dirname(fileURLToPath(import.meta.url));
const REPO = dirname(here);
const PORT = Number(process.env.DSH_MOLI_TEST_PORT ?? 9333);

if (typeof globalThis.WebSocket !== 'function') {
  console.log(`SKIP: moli_session needs Node >= 21 for the built-in WebSocket; this is ${process.versions.node}`);
  process.exit(0);
}

// This suite drives the moli backend, so it needs an engine. A CI runner has none,
// and "no engine" is a skip rather than a failure -- the same rule the engine tier
// follows, so a missing download never hides real breakage.
const { findMoli } = await import(pathToFileURL(join(REPO, 'lib', 'moli.js')).href);
if (findMoli(undefined) === undefined) {
  console.log('SKIP: no moli engine found, and this suite exercises the moli backend');
  process.exit(0);
}

const registered = new Map();
const { apply } = await import(pathToFileURL(join(REPO, 'index.js')).href);
apply({ tools: { register: d => registered.set(d.name, d) }, logger: { info() {}, warn() {} } },
  { insecureTls: true, sessionPort: PORT });
const sessionTool = registered.get('moli_session');
if (sessionTool === undefined) throw new Error('moli_session was not registered');

let pass = 0;
let fail = 0;
const check = (label, ok, extra = '') => {
  if (ok) { pass++; console.log(`  PASS ${label}${extra ? ` -- ${extra}` : ''}`); }
  else { fail++; console.log(`  FAIL ${label}${extra ? ` -- ${extra}` : ''}`); }
};
const run = args => sessionTool.execute({ ...args, timeoutMs: args.timeoutMs ?? 20000 }, {});

/** The fixture: a button, an input, a link, a lazy element, and scroll height. */
const FIXTURE = 'data:text/html;charset=utf-8,' + encodeURIComponent(`<!doctype html>
<html><head><title>session fixture</title></head><body>
  <h1 id="h">fixture</h1>
  <button id="btn" onclick="document.getElementById('h').textContent='clicked'">click me</button>
  <input id="inp" />
  <div id="out">empty</div>
  <a id="to" href="data:text/html;charset=utf-8,${encodeURIComponent('<title>second page</title><h1>second</h1>')}">go</a>
  <div style="height:4000px"></div>
  <span id="late" style="display:none">late content</span>
  <button id="reveal" onclick="document.getElementById('late').style.display='inline'">reveal</button>
  <span id="removable">temporary</span>
  <button id="remove" onclick="document.getElementById('removable').remove()">remove it</button>
  <!-- trailing space so these controls can actually be scrolled into view; a page
       that ends at the element leaves it clipped at the viewport edge -->
  <div style="height:1200px"></div>
</body></html>`);
const SECOND = 'data:text/html;charset=utf-8,' + encodeURIComponent('<title>second page</title><h1>second</h1>');

/** Resolve once something is listening on the port, or time out. */
function portUp(port, timeoutMs = 25000) {
  return new Promise(resolve => {
    const deadline = Date.now() + timeoutMs;
    const attempt = () => {
      const socket = createConnection({ host: '127.0.0.1', port });
      socket.once('connect', () => { socket.destroy(); resolve(true); });
      socket.once('error', () => {
        socket.destroy();
        if (Date.now() > deadline) resolve(false); else setTimeout(attempt, 250);
      });
    };
    attempt();
  });
}

console.log(`1. lifecycle (port ${String(PORT)})`);
const before = await run({ action: 'status' });
check('status works with nothing running', before.ok === true && before.running === false, `running=${String(before.running)}`);

const opened = await run({ action: 'open', url: FIXTURE });
check('open starts a session and navigates', opened.ok === true, String(opened.error ?? ''));
check('title read back', opened.title === 'session fixture', JSON.stringify(opened.title));

const status = await run({ action: 'status' });
check('status reports the session', status.running === true && status.ownedByThisPlugin === true);
check('status reports the current page', status.title === 'session fixture', JSON.stringify(status.url ?? '').slice(0, 60));
check('the plugin owns a pid', typeof status.pid === 'number', `pid=${String(status.pid)}`);
check('the chosen port is in use', await portUp(PORT, 3000));

console.log('\n2. snapshot');
const snap = await run({ action: 'snapshot' });
check('snapshot ok', snap.ok === true, String(snap.error ?? ''));
check('snapshot has the fixture text', String(snap.text).includes('fixture'), JSON.stringify(String(snap.text).slice(0, 60)));
check('snapshot lists the link', Array.isArray(snap.links) && snap.links.some(l => String(l.href).startsWith('data:')));
check('snapshot lists the input field', Array.isArray(snap.fields) && snap.fields.some(f => f.id === 'inp'));
check('the rendered formatter shows the text', String(sessionTool.output.render({}, snap)[0].text).includes('fixture'));

console.log('\n3. click');
const clicked = await run({ action: 'click', selector: '#btn' });
check('click ok', clicked.ok === true, String(clicked.error ?? ''));
check('the page handler ran', (await run({ action: 'eval', expression: "document.getElementById('h').textContent" })).value === 'clicked');
check('click reports the element it hit', clicked.clicked?.tag === 'button', JSON.stringify(clicked.clicked ?? null).slice(0, 80));
check('click reports no navigation for an in-page handler', clicked.navigated === false);

console.log('\n4. click on a missing selector is a result, not a crash');
const missing = await run({ action: 'click', selector: '#does-not-exist' });
check('ok is false', missing.ok === false);
check('the error names the selector', /does-not-exist/u.test(String(missing.error)), JSON.stringify(String(missing.error).slice(0, 70)));

console.log('\n5. type');
const typed = await run({ action: 'type', selector: '#inp', text: 'hello moli' });
check('type ok', typed.ok === true, String(typed.error ?? ''));
check('the field holds the text', typed.value === 'hello moli', JSON.stringify(typed.value));
const typedAgain = await run({ action: 'type', selector: '#inp', text: 'again', clear: true });
check('clear replaces instead of appending', typedAgain.value === 'again', JSON.stringify(typedAgain.value));

console.log('\n6. waitFor');
const waitedAttached = await run({ action: 'waitFor', selector: '#removable' });
check('waitFor attached returns at once for a present element', waitedAttached.ok === true && waitedAttached.state === 'attached',
  JSON.stringify(waitedAttached.state ?? waitedAttached.error));
await run({ action: 'click', selector: '#reveal' });
const waitedHidden = await run({ action: 'waitFor', selector: '#late' });
check('waitFor attached sees an element that was only hidden', waitedHidden.ok === true, JSON.stringify(waitedHidden.state ?? waitedHidden.error));
// `detached` means absent from the DOM: a hidden element still matches.
const hiddenNotDetached = await run({ action: 'waitFor', selector: '#late', state: 'detached', timeoutMs: 1200 });
check('a hidden element is not detached', hiddenNotDetached.ok === false, JSON.stringify(String(hiddenNotDetached.error).slice(0, 60)));
check('and the timeout explains the difference', /absent from the DOM/u.test(String(hiddenNotDetached.hint)),
  JSON.stringify(String(hiddenNotDetached.hint).slice(0, 70)));
await run({ action: 'click', selector: '#remove' });
// The engine's hit test is bounded by the viewport height while its element
// geometry ignores scrolling, so input cannot reach an element far down a long
// document. That is a property of the engine, not of this tool, and the useful
// behaviour is to say so and point at the route that does work.
const farClick = await run({ action: 'click', selector: '#remove' });
check('a click below the viewport is reported as an engine limit, not silently dropped',
  farClick.ok === false && /below the viewport|no box to click/u.test(String(farClick.error)),
  JSON.stringify(String(farClick.error).slice(0, 90)));
check('and the hint names the working alternative', /eval/u.test(String(farClick.hint)),
  JSON.stringify(String(farClick.hint).slice(0, 80)));

// The workaround the hint points at: clicking from inside the page.
const domClick = await run({ action: 'eval', expression: "document.querySelector('#remove').click(); 'clicked'" });
check('clicking through eval reaches the same element', domClick.value === 'clicked', JSON.stringify(domClick.value));
const afterDomClick = await run({ action: 'eval', expression: "document.getElementById('removable') === null ? 'removed' : 'still-there'" });
check('and it actually removed the element', afterDomClick.value === 'removed', String(afterDomClick.value));

// Put the element back so the detached wait below is meaningful.
await run({ action: 'eval', expression: "document.body.insertAdjacentHTML('beforeend', '<span id=\"removable\">temporary</span>')" });
const restored = await run({ action: 'waitFor', selector: '#removable', timeoutMs: 2000 });
check('the element can be re-added and waited for', restored.ok === true, JSON.stringify(restored.state ?? restored.error));
await run({ action: 'eval', expression: "document.getElementById('removable').remove()" });
const waitedDetached = await run({ action: 'waitFor', selector: '#removable', state: 'detached', timeoutMs: 3000 });
check('waitFor detached resolves once the element is removed', waitedDetached.ok === true && waitedDetached.state === 'detached',
  JSON.stringify(waitedDetached.state ?? waitedDetached.error));
const missed = await run({ action: 'waitFor', selector: '#never-appears', timeoutMs: 1200 });
check('waitFor times out with a clear error', missed.ok === false && /timed out/u.test(String(missed.error)),
  JSON.stringify(String(missed.error).slice(0, 70)));

console.log('\n7. scroll');
const scrolled = await run({ action: 'scroll', dy: 1200 });
check('scroll ok', scrolled.ok === true, String(scrolled.error ?? ''));
check('scrollY advanced', typeof scrolled.y === 'number' && scrolled.y > 0, `y=${String(scrolled.y)}`);
check('page height reported', typeof scrolled.height === 'number' && scrolled.height >= 4000, `height=${String(scrolled.height)}`);
const scrolledTo = await run({ action: 'scroll', selector: '#h' });
check('scroll to an element works', scrolledTo.ok === true, String(scrolledTo.error ?? ''));

console.log('\n8. eval');
const value = await run({ action: 'eval', expression: '({title: document.title, n: document.links.length})' });
check('eval returns a serialized object', value.ok === true && /session fixture/u.test(String(value.serialized)), String(value.serialized).slice(0, 70));
const promise = await run({ action: 'eval', expression: 'Promise.resolve(6 * 7)' });
check('eval awaits promises', promise.value === 42, JSON.stringify(promise.value));
const threw = await run({ action: 'eval', expression: 'null.missing' });
check('a throwing expression is reported, not thrown', threw.ok === false && /Cannot read|TypeError/u.test(String(threw.error)),
  JSON.stringify(String(threw.error).slice(0, 70)));
check('and it carries a useful hint', /expression threw/u.test(String(threw.hint)), JSON.stringify(String(threw.hint).slice(0, 60)));

console.log('\n9. screenshot');
const shotPath = join(REPO, 'verify', 'session-shot.png');
const shot = await run({ action: 'screenshot', writeTo: shotPath });
check('screenshot ok', shot.ok === true, String(shot.error ?? ''));
if (shot.ok === true) {
  const { readFileSync, unlinkSync, statSync } = await import('node:fs');
  const bytes = statSync(shotPath).size;
  const magic = [...readFileSync(shotPath).subarray(0, 8)].map(b => b.toString(16).padStart(2, '0')).join(' ');
  check('wrote a real PNG', magic === '89 50 4e 47 0d 0a 1a 0a', `${String(bytes)} bytes, magic ${magic}`);
  unlinkSync(shotPath);
}
const noPath = await run({ action: 'screenshot' });
check('screenshot without writeTo explains itself', noPath.ok === false && /writeTo/u.test(String(noPath.error)),
  JSON.stringify(String(noPath.error).slice(0, 70)));

console.log('\n10. navigation by clicking a link');
await run({ action: 'open', url: FIXTURE });
const linkClick = await run({ action: 'click', selector: '#to' });
check('click reports the navigation', linkClick.navigated === true, `url=${String(linkClick.url).slice(0, 40)}`);
const after = await run({ action: 'eval', expression: 'document.title' });
check('the new document is live', after.value === 'second page', JSON.stringify(after.value));

console.log('\n11. close releases the port');
const closed = await run({ action: 'close' });
check('close reports it stopped the server', closed.stopped === true, JSON.stringify(closed));
const afterClose = await run({ action: 'status' });
check('status shows nothing running', afterClose.running === false, `running=${String(afterClose.running)}`);
await new Promise(r => setTimeout(r, 500));
check('the port is free again', (await portUp(PORT, 1500)) === false);

console.log('\n12. a session can be restarted after close');
const reopened = await run({ action: 'open', url: FIXTURE });
check('reopen works', reopened.ok === true, String(reopened.error ?? ''));
check('and the page is live', (await run({ action: 'eval', expression: 'document.title' })).value === 'session fixture');
await run({ action: 'close' });

console.log(`\nresult: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
