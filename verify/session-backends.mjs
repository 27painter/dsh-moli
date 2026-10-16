// The two session backends, side by side, on the same page.
//
// This is the test that justifies the second backend existing at all. Moli's
// element geometry is document-absolute and its hit test is bounded by the
// viewport height, so synthetic input cannot reach an element below the first
// viewport on a page long enough to scroll. A real Chromium reports standard
// geometry and reaches it. Both statements are asserted here, against the same
// fixture, so a regression in either direction shows up as a failure rather than
// as a quietly narrower tool.
//
// The `cdp` action is checked on both: it is the escape hatch for everything the
// named actions do not cover, and it has to work whichever browser answers.
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createConnection } from 'node:net';

const here = dirname(fileURLToPath(import.meta.url));
const REPO = dirname(here);

if (typeof globalThis.WebSocket !== 'function') {
  console.log(`SKIP: moli_session needs Node >= 21 for the built-in WebSocket; this is ${process.versions.node}`);
  process.exit(0);
}

let pass = 0;
let fail = 0;
const check = (label, ok, extra = '') => {
  if (ok) { pass++; console.log(`  PASS ${label}${extra ? ` -- ${extra}` : ''}`); }
  else { fail++; console.log(`  FAIL ${label}${extra ? ` -- ${extra}` : ''}`); }
};

/** A fixture with a control at the top and another far down the document. */
const FIXTURE = 'data:text/html;charset=utf-8,' + encodeURIComponent(`<!doctype html>
<html><head><title>backends</title></head><body>
  <button id="near" onclick="document.title='near-clicked'" style="height:40px">near</button>
  <div style="height:2500px"></div>
  <button id="far" onclick="document.title='far-clicked'" style="height:40px">far</button>
  <div style="height:800px"></div>
</body></html>`);

function portFree(port, timeoutMs = 1200) {
  return new Promise(resolve => {
    const socket = createConnection({ host: '127.0.0.1', port });
    socket.once('connect', () => { socket.destroy(); resolve(false); });
    socket.once('error', () => { socket.destroy(); resolve(true); });
    setTimeout(() => { socket.destroy(); resolve(true); }, timeoutMs);
  });
}

/** Bring up a tool bound to one backend and return helpers for it. */
async function withBackend(browser, port, run) {
  const registered = new Map();
  const { apply } = await import(pathToFileURL(join(REPO, 'index.js')).href);
  apply({ tools: { register: d => registered.set(d.name, d) }, logger: { info() {}, warn() {} } },
    { insecureTls: true, sessionPort: port, sessionBrowser: browser });
  const tool = registered.get('moli_session');
  const call = args => tool.execute({ ...args, timeoutMs: args.timeoutMs ?? 25000 }, {});
  try {
    return await run(call);
  } finally {
    await call({ action: 'close' }).catch(() => undefined);
  }
}

console.log('=== moli backend: the viewport wall ===');
await withBackend('moli', 9333, async run => {
  const opened = await run({ action: 'open', url: FIXTURE });
  check('session starts and navigates', opened.ok === true, String(opened.error ?? ''));

  const status = await run({ action: 'status' });
  check('status names the backend', status.backend === 'moli', String(status.backend));
  check('status names the geometry frame', status.geometry === 'absolute', String(status.geometry));

  const near = await run({ action: 'click', selector: '#near' });
  check('a control in the first viewport clicks', near.ok === true, String(near.error ?? ''));
  check('and its handler ran', (await run({ action: 'eval', expression: 'document.title' })).value === 'near-clicked');

  const far = await run({ action: 'click', selector: '#far' });
  check('a control below the viewport is refused, with the reason', far.ok === false && /below the viewport|bounded/u.test(String(far.error) + String(far.hint)),
    JSON.stringify(String(far.error).slice(0, 90)));
  check('and the hint points at eval or the chromium backend', /eval|chromium/u.test(String(far.hint)));

  // The workaround the hint names.
  const viaEval = await run({ action: 'eval', expression: "document.querySelector('#far').click(); 'ok'" });
  check('clicking it through eval works', viaEval.value === 'ok' && (await run({ action: 'eval', expression: 'document.title' })).value === 'far-clicked',
    JSON.stringify(viaEval.value));

  console.log('\n  cdp escape hatch (moli)');
  // CDP results are camelCase (`protocolVersion`), unlike the `--version` CLI text
  // that spells it `Protocol-Version`. Asserting the wrong one failed while the
  // command was working perfectly.
  const version = await run({ action: 'cdp', method: 'Browser.getVersion' });
  check('Browser.getVersion returns a protocol version', version.ok === true && /"protocolVersion"\s*:\s*"/u.test(String(version.serialized)),
    JSON.stringify(String(version.serialized).slice(0, 90)));
  const nav = await run({ action: 'cdp', method: 'Page.navigate', params: { url: 'about:blank' } });
  check('Page.navigate accepts object params', nav.ok === true, String(nav.error ?? ''));
  const asString = await run({ action: 'cdp', method: 'Runtime.evaluate', params: '{"expression":"1+1","returnByValue":true}' });
  check('params also accepted as a JSON string', asString.ok === true && /"value":2/u.test(String(asString.serialized)),
    JSON.stringify(String(asString.serialized).slice(0, 60)));
  const bad = await run({ action: 'cdp', method: 'No.SuchMethod' });
  check('an unknown method is reported, not thrown', bad.ok === false && /No\.SuchMethod/u.test(String(bad.error)),
    JSON.stringify(String(bad.error).slice(0, 70)));
  const badJson = await run({ action: 'cdp', method: 'Runtime.evaluate', params: '{not json' });
  check('malformed params JSON is reported', badJson.ok === false && /not valid JSON/u.test(String(badJson.error)),
    JSON.stringify(String(badJson.error).slice(0, 60)));
});

console.log('\n=== chromium backend: standard geometry ===');
const chromiumAvailable = await import(pathToFileURL(join(REPO, 'lib', 'session.js')).href)
  .then(m => m.findChromium(undefined) !== undefined);
if (!chromiumAvailable) {
  console.log('  SKIP: no Chromium-family browser on this machine (Chrome, Edge or Brave)');
} else {
  await withBackend('chromium', 9334, async run => {
    const opened = await run({ action: 'open', url: FIXTURE });
    check('session starts and navigates', opened.ok === true, String(opened.error ?? ''));

    const status = await run({ action: 'status' });
    // The predicate must be able to fail: an earlier version of this line ended in
    // `|| opened.ok === true`, which made it pass unconditionally.
    check('the CDP endpoint reports a real Chromium', /Chrome|Edg|Brave/u.test(String(status.browserVersion)),
      JSON.stringify(String(status.browserVersion)));
    check('status names the backend', status.backend === 'chromium', String(status.backend));
    check('status names the geometry frame', status.geometry === 'viewport', String(status.geometry));

    const near = await run({ action: 'click', selector: '#near' });
    check('a control in the first viewport clicks', near.ok === true, String(near.error ?? ''));
    check('and its handler ran', (await run({ action: 'eval', expression: 'document.title' })).value === 'near-clicked');

    // The decisive difference from the moli run above.
    const far = await run({ action: 'click', selector: '#far' });
    check('a control below the viewport clicks, because the browser scrolls to it', far.ok === true,
      String(far.error ?? ''));
    check('and its handler ran', (await run({ action: 'eval', expression: 'document.title' })).value === 'far-clicked',
      JSON.stringify((await run({ action: 'eval', expression: 'document.title' })).value));

    console.log('\n  cdp escape hatch (chromium)');
    const version = await run({ action: 'cdp', method: 'Browser.getVersion' });
    check('Browser.getVersion returns a protocol version', version.ok === true && /"protocolVersion"\s*:\s*"/u.test(String(version.serialized)),
      JSON.stringify(String(version.serialized).slice(0, 90)));
    // Something the named actions do not offer: extra request headers.
    const headers = await run({ action: 'cdp', method: 'Network.setExtraHTTPHeaders', params: { headers: { 'X-Dsh-Moli': 'test' } } });
    check('Network.setExtraHTTPHeaders is reachable', headers.ok === true, String(headers.error ?? ''));
  });
}

console.log('\n=== closing releases the port on both ===');
for (const [browser, port] of [['moli', 9333], ['chromium', 9334]]) {
  if (browser === 'chromium' && !chromiumAvailable) continue;
  check(`${browser} port ${String(port)} is free after close`, await portFree(port));
}

console.log(`\nresult: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
