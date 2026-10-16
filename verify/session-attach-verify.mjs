// Attaching to a browser that is already running.
//
// This is the path that makes a user's own logins usable: they start a real
// browser with remote debugging, hand over the endpoint, and the session drives
// it. Three things have to hold -- the tool must identify that browser rather than
// assume, `close` must leave it running (a browser this plugin did not start is
// not this plugin's to stop), and identification must survive the fact that moli
// reports itself as Chrome.
import { spawn } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, openSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const REPO = dirname(here);

if (typeof globalThis.WebSocket !== 'function') {
  console.log(`SKIP: moli_session needs Node >= 21; this is ${process.versions.node}`);
  process.exit(0);
}

let pass = 0;
let fail = 0;
const check = (label, ok, extra = '') => {
  if (ok) { pass++; console.log(`  PASS ${label}${extra ? ` -- ${extra}` : ''}`); }
  else { fail++; console.log(`  FAIL ${label}${extra ? ` -- ${extra}` : ''}`); }
};
const sleep = ms => new Promise(r => setTimeout(r, ms));

/** Wait for a CDP endpoint to answer, returning whether it did. */
async function waitForEndpoint(endpoint, timeoutMs = 25000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try { if ((await fetch(`${endpoint}/json/version`)).ok) return true; } catch { /* wait */ }
    if (Date.now() > deadline) return false;
    await sleep(400);
  }
}

async function endpointAlive(endpoint) {
  try { return (await fetch(`${endpoint}/json/version`)).ok; } catch { return false; }
}

// A fixture with a control at the top and another far down the document.
const LONG_PAGE = 'data:text/html;charset=utf-8,' + encodeURIComponent(
  '<!doctype html><title>attach</title><button id="n">near</button>'
  + '<div style="height:2500px"></div><button id="f" onclick="document.title=\'far\'">far</button>'
  + '<div style="height:800px"></div>');

const registered = new Map();
const { apply } = await import(pathToFileURL(join(REPO, 'index.js')).href);
const { findChromium } = await import(pathToFileURL(join(REPO, 'lib', 'session.js')).href);
const { findMoli } = await import(pathToFileURL(join(REPO, 'lib', 'moli.js')).href);

// The plugin is configured for moli throughout: a per-call endpoint must override it.
apply({ tools: { register: d => registered.set(d.name, d) }, logger: { info() {}, warn() {} } },
  { insecureTls: true, sessionBrowser: 'moli', sessionPort: 9336 });
const tool = registered.get('moli_session');
const run = args => tool.execute({ ...args, timeoutMs: args.timeoutMs ?? 25000 }, {});

const started = [];

// ---------------------------------------------------------------------------
// 1. A real Chromium, started outside the plugin.
// ---------------------------------------------------------------------------
const chromeExe = findChromium(undefined);
const CHROME_PORT = 9335;
const chromeEndpoint = `http://127.0.0.1:${String(CHROME_PORT)}`;
const chromeProfile = join(tmpdir(), `dsh-attach-${String(process.pid)}`);

if (chromeExe === undefined) {
  console.log('SKIP: no Chromium-family browser on this machine');
} else {
  mkdirSync(chromeProfile, { recursive: true });
  const logFd = openSync(join(tmpdir(), 'dsh-attach.log'), 'w');
  const browser = spawn(chromeExe, [
    `--remote-debugging-port=${String(CHROME_PORT)}`, '--remote-debugging-address=127.0.0.1',
    `--user-data-dir=${chromeProfile}`, '--headless=new', '--no-first-run', '--no-default-browser-check',
    '--disable-gpu', 'about:blank',
  ], { stdio: ['ignore', logFd, logFd], windowsHide: true });
  closeSync(logFd);
  started.push(browser);

  console.log('1. attach to a Chromium started outside the plugin');
  check('the external browser is running first', await waitForEndpoint(chromeEndpoint));

  const opened = await run({ action: 'open', url: LONG_PAGE, cdpEndpoint: chromeEndpoint });
  check('the tool attaches and navigates', opened.ok === true, String(opened.error ?? ''));
  check('it read the page', opened.title === 'attach', JSON.stringify(opened.title));

  const status = await run({ action: 'status', cdpEndpoint: chromeEndpoint });
  check('status reports the endpoint as external', status.external === true, `external=${String(status.external)}`);
  check('it identifies the real browser', status.backend === 'chromium', String(status.backend));
  check('and uses standard geometry', status.geometry === 'viewport', String(status.geometry));
  check('it spawned nothing, so there is no pid of ours', status.pid === undefined, String(status.pid));

  console.log('\n2. raw CDP goes to the attached browser');
  const cdp = await run({ action: 'cdp', method: 'Browser.getVersion', cdpEndpoint: chromeEndpoint });
  check('Browser.getVersion answers', cdp.ok === true && /"product"\s*:\s*"[^"]*(Chrome|Edg|Brave)/u.test(String(cdp.serialized)),
    JSON.stringify(String(cdp.serialized).slice(0, 80)));

  console.log('\n3. close must not stop a browser it did not start');
  const closed = await run({ action: 'close' });
  check('close reports nothing stopped', closed.stopped === false, JSON.stringify(closed));
  await sleep(600);
  check('the external browser is still running', await endpointAlive(chromeEndpoint));

  console.log('\n4. and it can be attached to again');
  const again = await run({ action: 'open', url: LONG_PAGE, cdpEndpoint: chromeEndpoint });
  check('re-attaching works', again.ok === true, String(again.error ?? ''));
  await run({ action: 'close' });

  console.log('\n5. a dead endpoint is reported, not thrown');
  const dead = await run({ action: 'open', url: LONG_PAGE, cdpEndpoint: 'http://127.0.0.1:9/' });
  check('ok is false', dead.ok === false);
  check('the error names the endpoint', /no CDP endpoint answers/u.test(String(dead.error)),
    JSON.stringify(String(dead.error).slice(0, 80)));
}

// ---------------------------------------------------------------------------
// 6. The trap: moli reports itself as Chrome, so the frame cannot be read off the
//    name. Attaching to a moli someone else started must still pick moli's frame.
// ---------------------------------------------------------------------------
const moliExe = findMoli(undefined);
if (moliExe === undefined) {
  console.log('\nSKIP: no moli engine, so the misidentification case cannot be exercised');
} else {
  const MOLI_PORT = 9337;
  const moliEndpoint = `http://127.0.0.1:${String(MOLI_PORT)}`;
  const moliLog = openSync(join(tmpdir(), 'dsh-attach-moli.log'), 'w');
  const moli = spawn(moliExe, ['serve', '--port', String(MOLI_PORT), '--layout'],
    { stdio: ['ignore', moliLog, moliLog], windowsHide: true });
  closeSync(moliLog);
  started.push(moli);

  console.log('\n6. an external moli is detected as moli, not as Chrome');
  check('the external moli is running', await waitForEndpoint(moliEndpoint));

  const version = await (await fetch(`${moliEndpoint}/json/version`)).json();
  check('it reports itself as Chrome, which is the trap', /Chrome/u.test(String(version.Browser)),
    JSON.stringify(version.Browser));
  check('but its debugger URL carries its own name', /moli/iu.test(String(version.webSocketDebuggerUrl)),
    JSON.stringify(String(version.webSocketDebuggerUrl)));

  // Every call names the endpoint, because the plugin is configured for moli on a
  // different port -- so this also exercises that a per-call endpoint is honoured.
  const stated = await run({ action: 'status', cdpEndpoint: moliEndpoint });
  check('the tool still identifies it as moli', stated.backend === 'moli', String(stated.backend));
  check('and uses the absolute frame, not the standard one', stated.geometry === 'absolute', String(stated.geometry));
  check('and reports the endpoint it was given', String(stated.endpoint) === moliEndpoint, String(stated.endpoint));

  // Behaviour, not just labels: the viewport wall must be in force.
  await run({ action: 'open', url: LONG_PAGE, cdpEndpoint: moliEndpoint });
  const near = await run({ action: 'click', selector: '#n', cdpEndpoint: moliEndpoint });
  check('a near control clicks', near.ok === true, String(near.error ?? ''));
  const far = await run({ action: 'click', selector: '#f', cdpEndpoint: moliEndpoint });
  check('a far control is refused, proving moli\'s frame is in use', far.ok === false,
    JSON.stringify(String(far.error).slice(0, 70)));
  await run({ action: 'close' });

  // A per-call endpoint must not latch. An earlier version assigned it to the
  // session permanently, so naming a dead endpoint once broke every later call, and
  // naming a live one silently redirected the whole session to it.
  console.log('\n7. a per-call endpoint does not poison later calls');
  await run({ action: 'open', url: LONG_PAGE, cdpEndpoint: 'http://127.0.0.1:9/' });
  const afterDead = await run({ action: 'status' });
  check('the restored endpoint is the configured one, not the dead one', /9336/u.test(String(afterDead.endpoint)),
    String(afterDead.endpoint));
  const ownBrowser = await run({ action: 'open', url: LONG_PAGE });
  check('and a normal call still works on the configured browser', ownBrowser.ok === true,
    String(ownBrowser.error ?? ''));
  check('on the port the plugin was configured with', /9336/u.test(String((await run({ action: 'status' })).endpoint)),
    String((await run({ action: 'status' })).endpoint));

  // `close` must be scoped too, and must not reach the configured browser while an
  // endpoint is named: it is the action that stops processes.
  console.log('\n8. close with an endpoint must not stop the configured browser');
  const openedOwn = await run({ action: 'open', url: LONG_PAGE });
  check('the managed browser is running first', openedOwn.ok === true, String(openedOwn.error ?? ''));
  const closedOther = await run({ action: 'close', cdpEndpoint: moliEndpoint });
  check('close against the external endpoint reports nothing stopped of ours',
    closedOther.stopped === false, JSON.stringify(closedOther));
  await sleep(300);
  check('an external moli is still running after that close', await endpointAlive(moliEndpoint));
  const ownStill = await run({ action: 'status' });
  check('and the managed session is still alive', ownStill.running === true, `running=${String(ownStill.running)}`);
  await run({ action: 'close' });
}

// ---------------------------------------------------------------------------
for (const child of started) { try { child.kill('SIGKILL'); } catch { /* ignore */ } }
await sleep(500);
if (existsSync(chromeProfile)) { try { rmSync(chromeProfile, { recursive: true, force: true }); } catch { /* locked */ } }

console.log(`\nresult: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
