// Windows install-path verification for the dsh-moli fork.
//
// Usage:
//   node verify/win-verify.mjs
//
// The pure-function assertions (proxy prelude / env / route text) run on every
// platform. On Windows they are followed by real checks against powershell.exe:
// the DefaultWebProxy prelude is executed and inspected, the download routes are
// exercised against a reachable URL, and (optionally) a full installMoli run
// confirms the whole Windows pipeline.
//
// Exit code 0 = all checks passed, 1 = any failed.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const pluginRoot = dirname(here);
const {
  powershellProxyPrelude,
  proxyEnv,
  proxyListens,
  downloadInstaller,
  installMoli,
} = await import(pathToFileURL(join(pluginRoot, 'lib', 'install.js')).href);

let pass = 0;
let fail = 0;
const check = (label, ok, extra = '') => {
  if (ok) { pass++; console.log(`  PASS ${label}${extra ? ' -- ' + extra : ''}`); }
  else { fail++; console.log(`  FAIL ${label}${extra ? ' -- ' + extra : ''}`); }
};
const isWin = process.platform === 'win32';
console.log(`platform: ${process.platform}${isWin ? ' (Windows — full checks)' : ' (non-Windows — prelude text checks only)'}`);

console.log('\n1. powershellProxyPrelude (proxy injection text)');
const plain = powershellProxyPrelude('http://127.0.0.1:7890');
check('plain proxy targets DefaultWebProxy', plain.includes('[System.Net.WebRequest]::DefaultWebProxy = $__dshMoliProxy;'));
check('plain proxy address quoted once', plain.includes("New-Object System.Net.WebProxy('http://127.0.0.1:7890')"));
check('plain proxy has no credentials line', !plain.includes('NetworkCredential'));

const authed = powershellProxyPrelude('http://user:pass@127.0.0.1:7890');
check('authed proxy sets NetworkCredential', authed.includes('NetworkCredential'));
check('authed user/pass embedded', authed.includes("'user'") && authed.includes("'pass'"));
check('authed still sets DefaultWebProxy', authed.includes('DefaultWebProxy = $__dshMoliProxy;'));

check('garbage proxy yields empty prelude', powershellProxyPrelude('not-a-url') === '');
check('empty proxy yields empty prelude', powershellProxyPrelude('') === '');

const escaped = powershellProxyPrelude("http://u'ser:p@ss@127.0.0.1:7890");
check("single quotes in credentials escaped", escaped.includes("u''ser") && escaped.includes("p@ss"));

console.log('\n2. proxyEnv (curl environment injection)');
const env = proxyEnv('http://127.0.0.1:7890');
check('sets HTTPS_PROXY', env.HTTPS_PROXY === 'http://127.0.0.1:7890');
check('sets https_proxy', env.https_proxy === 'http://127.0.0.1:7890');
check('sets HTTP_PROXY / http_proxy', env.HTTP_PROXY === 'http://127.0.0.1:7890' && env.http_proxy === 'http://127.0.0.1:7890');
check('sets ALL_PROXY / all_proxy', env.ALL_PROXY === 'http://127.0.0.1:7890' && env.all_proxy === 'http://127.0.0.1:7890');
check('garbage proxy yields empty env', Object.keys(proxyEnv('bad')).length === 0);

if (isWin) {
  console.log('\n3. PowerShell prelude executes and sets the proxy object (real powershell.exe)');
  const prelude = powershellProxyPrelude('http://127.0.0.1:9');
  const probe = spawnSync('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command',
    `${prelude} if ($null -eq $__dshMoliProxy) { exit 1 }; $addr = [string]$__dshMoliProxy.Address; if ($addr -ne 'http://127.0.0.1:9/') { Write-Host $addr; exit 2 }; exit 0`,
  ], { timeout: 30000, encoding: 'utf8' });
  check('prelude parses and address matches', probe.status === 0, `exit ${probe.status} ${probe.stdout ?? ''}`);

  const authedProbe = spawnSync('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command',
    `${powershellProxyPrelude('http://alice:s3cr3t@127.0.0.1:9')} if ($null -eq $__dshMoliProxy.Credentials) { exit 3 }; $cred = $__dshMoliProxy.Credentials.GetCredential('http://127.0.0.1:9', 'Basic'); if ($null -eq $cred) { exit 4 }; if ($cred.UserName -ne 'alice') { Write-Host $cred.UserName; exit 5 }; exit 0`,
  ], { timeout: 30000, encoding: 'utf8' });
  check('authed prelude sets usable credentials', authedProbe.status === 0, `exit ${authedProbe.status} ${authedProbe.stdout ?? ''}`);

  console.log('\n4. downloadInstaller Windows routes (loopback server)');
  const dir = mkdtempSync(join(tmpdir(), 'dsh-moli-win-'));
  const marker = join(dir, 'ran.txt');
  // A .ps1 fixture that the plugin downloads; it only writes a marker, so a
  // matching-checksum install confirms the whole Windows run path without
  // needing a real engine download.
  const fixturePath = join(dir, 'fixture.ps1');
  const { writeFileSync } = await import('node:fs');
  const fixture = `Set-Content -Path '${marker.replace(/\\/gu, '\\\\')}' -Value 'RAN'; exit 0\n`;
  writeFileSync(fixturePath, fixture, { encoding: 'utf8' });

  // Serve it from a tiny in-process server (spawnSync does not block a separate
  // process, so an in-process server would deadlock — hence spawn a server child).
  const { spawn } = await import('node:child_process');
  const { createHash } = await import('node:crypto');
  const server = spawn(process.execPath, ['-e', `
    const http = require('node:http');
    const fs = require('node:fs');
    const body = fs.readFileSync(process.argv[1]);
    http.createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end(body);
    }).listen(Number(process.argv[2]), '127.0.0.1');
  `, fixturePath, '18125'], { stdio: 'ignore' });
  await new Promise(r => setTimeout(r, 1200));
  const sha = createHash('sha256').update(Buffer.from(fixture, 'utf8')).digest('hex');
  const url = 'http://127.0.0.1:18125/fixture.ps1';

  const dl = await downloadInstaller({ target: join(dir, 'got.ps1'), installerUrl: url, timeoutMs: 20000, locate: () => undefined });
  check('a Windows route succeeds', dl.ok === true, dl.ok ? `via ${dl.method}` : JSON.stringify(dl.attempts));
  check('digest matches', dl.sha256 === sha, String(dl.sha256).slice(0, 12));

  console.log('\n5. installMoli Windows run path (matching checksum, marker fixture)');
  const good = await installMoli({ installerUrl: url, expectedSha256: sha, timeoutMs: 60000, locate: () => undefined });
  check('installer executed on Windows', existsSync(marker), existsSync(marker) ? 'marker present' : 'no marker');
  check('no engine found is reported honestly', good.ok === false && /no working moli binary/u.test(String(good.error)), String(good.error).slice(0, 60));

  server.kill();
  rmSync(dir, { recursive: true, force: true });
}

console.log(`\nresult: ${pass} passed, ${fail} failed`);
process.exitCode = fail === 0 ? 0 : 1;
