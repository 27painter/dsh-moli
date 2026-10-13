// Linux/macOS install-path verification for the dsh-moli fork.
//
// Usage:
//   node verify/linux-verify.mjs
//
// Runs on POSIX hosts. It asserts the pure proxy-helper functions, then proves
// the two behavioural guarantees of the async rewrite against a real install:
//   1. the installer child process receives the proxy through its environment
//      (the official installer.sh's curl reads HTTPS_PROXY / HTTP_PROXY), and
//   2. the DSH host event loop stays live while the installer runs (the async
//      acceptance criterion: a hung installer must not freeze the host).
// A tiny in-process proxy is started so the proxy is genuinely "alive", which
// is what makes installMoli inject the proxy environment in the first place.
//
// Exit code 0 = all checks passed, 1 = any failed.
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const pluginRoot = dirname(here);
const {
  powershellProxyPrelude,
  proxyEnv,
  proxyListens,
  installMoli,
} = await import(pathToFileURL(join(pluginRoot, 'lib', 'install.js')).href);
const { findMoli } = await import(pathToFileURL(join(pluginRoot, 'lib', 'moli.js')).href);

let pass = 0;
let fail = 0;
const check = (label, ok, extra = '') => {
  if (ok) { pass++; console.log(`  PASS ${label}${extra ? ' -- ' + extra : ''}`); }
  else { fail++; console.log(`  FAIL ${label}${extra ? ' -- ' + extra : ''}`); }
};

if (process.platform === 'win32') {
  console.log('This script verifies the POSIX install path; run it on Linux/macOS.');
  process.exit(2);
}
console.log(`platform: ${process.platform}`);

console.log('\n1. proxy helper functions (pure assertions)');
const env = proxyEnv('http://127.0.0.1:7890');
check('proxyEnv sets HTTPS_PROXY', env.HTTPS_PROXY === 'http://127.0.0.1:7890');
check('proxyEnv sets https_proxy', env.https_proxy === 'http://127.0.0.1:7890');
check('proxyEnv sets HTTP_PROXY', env.HTTP_PROXY === 'http://127.0.0.1:7890');
check('proxyEnv sets http_proxy', env.http_proxy === 'http://127.0.0.1:7890');
check('proxyEnv sets ALL_PROXY', env.ALL_PROXY === 'http://127.0.0.1:7890');
check('proxyEnv sets all_proxy', env.all_proxy === 'http://127.0.0.1:7890');
check('proxyEnv empty for garbage', Object.keys(proxyEnv('bad')).length === 0);
const prelude = powershellProxyPrelude('http://user:pass@127.0.0.1:7890');
check('powershellProxyPrelude (text) embeds credentials', prelude.includes('NetworkCredential') && prelude.includes("'user'"));

console.log('\n2. proxy + event-loop liveness while the installer runs (async acceptance)');
// The async acceptance criterion: a slow installer must not block the host.
// The fixture sleeps ~2s then captures the proxy environment it received and
// writes its marker; a live event loop should tick dozens of times meanwhile.
const dir = mkdtempSync(join(tmpdir(), 'dsh-moli-linux-'));
const fixtureName = 'moli-installer.sh';
const fixture = join(dir, fixtureName);
const marker = join(dir, 'ran.txt');
const envCapture = join(dir, 'env.txt');
const writeFixture = (markerPath, extraLines = []) => writeFileSync(fixture, [
  '#!/bin/sh',
  ...extraLines,
  `printf '%s' "\${HTTPS_PROXY:-NO-PROXY-ENV}" > '${envCapture}'`,
  `printf 'INSTALLER-RAN' > '${markerPath}'`,
  'exit 0',
  '',
].join('\n'), { encoding: 'utf8' });

// Write the initial fixture BEFORE the server starts: the server re-reads the
// file on every request, so later rewrites (the no-proxy scenario) are served
// with their own bytes and digest.
writeFixture(marker, ['sleep 2']);

// Serve the fixture from a child server (spawned, so it does not share this
// process's event loop) and run a tiny forward proxy for the loopback request.
const server = spawn(process.execPath, ['-e', `
  const http = require('node:http');
  const fs = require('node:fs');
  http.createServer((req, res) => {
    let body;
    try { body = fs.readFileSync(process.argv[1]); } catch { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end(body);
  }).listen(Number(process.argv[2]), '127.0.0.1');
`, fixture, '18126'], { stdio: 'ignore' });
const proxySrv = spawn(process.execPath, ['-e', `
  const http = require('node:http');
  http.createServer((req, res) => {
    let u;
    try { u = new URL(req.url); } catch { res.writeHead(400); res.end(); return; }
    const upstream = http.request({ host: u.hostname, port: u.port || 80, path: u.pathname + u.search, method: req.method, headers: req.headers }, r => {
      res.writeHead(r.statusCode, r.headers); r.pipe(res);
    });
    upstream.on('error', () => { res.writeHead(502); res.end(); });
    req.pipe(upstream);
  }).listen(Number(process.argv[1]), '127.0.0.1');
`, '7891'], { stdio: 'ignore' });
await new Promise(r => setTimeout(r, 1200));

const proxyUrl = 'http://127.0.0.1:7891';
const alive = await proxyListens(proxyUrl);
check('local proxy is alive', alive === true);
if (!alive) { console.log('proxy probe failed; cannot test proxy injection'); process.exit(1); }

const script1 = readFileSync(fixture, 'utf8');
const sha1 = createHash('sha256').update(Buffer.from(script1, 'utf8')).digest('hex');
const url = `http://127.0.0.1:18126/${fixtureName}`;

let ticks = 0;
const ticker = setInterval(() => { ticks++; }, 100);
const install = await installMoli({ installerUrl: url, expectedSha256: sha1, proxy: proxyUrl, timeoutMs: 30000, locate: findMoli });
clearInterval(ticker);
check('install with proxy env succeeded', install.ok === true, `version=${String(install.version)}`);
check('event loop stayed live (~2s sleep, 100ms ticker)', ticks >= 10, `${ticks} ticks`);
const captured = existsSync(envCapture) ? readFileSync(envCapture, 'utf8') : 'NO-CAPTURE';
check('proxy env reached the installer child', captured === proxyUrl, `got "${captured}"`);

console.log('\n3. install path without proxy');
const marker2 = join(dir, 'ran2.txt');
writeFixture(marker2);
const script2 = readFileSync(fixture, 'utf8');
const sha2 = createHash('sha256').update(Buffer.from(script2, 'utf8')).digest('hex');
const install2 = await installMoli({ installerUrl: url, expectedSha256: sha2, timeoutMs: 30000, locate: findMoli });
check('no-proxy install runs the installer', install2.ok === true && existsSync(marker2), install2.ok ? '' : String(install2.error).slice(0, 60));

server.kill();
proxySrv.kill();
rmSync(dir, { recursive: true, force: true });

console.log(`\nresult: ${pass} passed, ${fail} failed`);
process.exitCode = fail === 0 ? 0 : 1;
