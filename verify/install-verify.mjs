// Validate the install pipeline against a loopback HTTP server.
//
// Two harness details matter, and both were learned the hard way:
// 1. The server must run in a SEPARATE process. `spawnSync` blocks this process's
//    event loop, so an in-process server can never accept the connection and every
//    child request times out — a harness bug that looks exactly like a failure.
// 2. The server is started with the async `spawn`, so this process stays alive to
//    serve the fixture file it wrote itself.
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Resolve the plugin by path rather than by an installed copy, so this runs
// against the working tree whether or not anything is installed in a profile.
const here = dirname(fileURLToPath(import.meta.url));
const pluginRoot = dirname(here);
const { installMoli, downloadInstaller, sha256File, MANUAL_INSTALL, proxyListens } =
  await import(pathToFileURL(join(pluginRoot, 'lib', 'install.js')).href);

const PORT = 18101;
const BASE = `http://127.0.0.1:${String(PORT)}`;
let pass = 0;
let fail = 0;
const check = (label, ok, extra = '') => {
  if (ok) { pass++; console.log(`  PASS ${label}${extra ? ' -- ' + extra : ''}`); }
  else { fail++; console.log(`  FAIL ${label}${extra ? ' -- ' + extra : ''}`); }
};

// The fixture installer writes a marker when it runs. ASCII, no BOM: Windows
// PowerShell reads a BOM-less UTF-8 .ps1 as the system codepage.
const dir = mkdtempSync(join(tmpdir(), 'dsh-moli-fixture-'));
const fixture = join(dir, 'moli-installer.ps1');
const marker = join(dir, 'ran.txt');
const script = `Set-Content -Path '${marker.replace(/\\/gu, '\\\\')}' -Value 'INSTALLER-RAN'; exit 0\n`;
writeFileSync(fixture, script, { encoding: 'utf8' });
const installerSha = createHash('sha256').update(Buffer.from(script, 'utf8')).digest('hex');
const installerUrl = `${BASE}/moli-installer.ps1`;

const server = spawn(process.execPath, [join(here, 'test-server.mjs'), fixture, String(PORT)], { stdio: 'ignore' });
await new Promise(resolve => setTimeout(resolve, 1500));
if (server.exitCode !== null) throw new Error('test server exited early');

console.log(`server     ${BASE}`);
console.log(`installer  ${installerUrl}`);
console.log(`sha256     ${installerSha}`);
console.log(`marker     ${marker}\n`);

console.log('0. proxy liveness probe');
check('dead port not listening', (await proxyListens('http://127.0.0.1:9')) === false);
check('live port listening', (await proxyListens(BASE)) === true);
check('garbage proxy not listening', (await proxyListens('not-a-url')) === false);

console.log('\n1. download routes (dead proxy supplied, must be skipped)');
const dl = await downloadInstaller({
  target: join(mkdtempSync(join(tmpdir(), 'dsh-moli-dl-')), 'i.ps1'),
  installerUrl,
  proxy: 'http://127.0.0.1:9',
  timeoutMs: 20000,
  locate: () => undefined,
});
check('a route succeeded', dl.ok === true, dl.ok ? `via ${dl.method}` : JSON.stringify(dl.attempts));
check('digest matches served bytes', dl.sha256 === installerSha, String(dl.sha256).slice(0, 16));
check('dead proxy route skipped', !dl.attempts.some(a => /proxy/u.test(a.method)), dl.attempts.map(a => a.method).join(' | '));

console.log('\n2. checksum mismatch refuses to execute');
const bad = await installMoli({ installerUrl, expectedSha256: 'deadbeef'.repeat(8), timeoutMs: 60000, locate: () => undefined });
check('failed', bad.ok === false);
check('reason is the mismatch', /checksum mismatch/u.test(String(bad.error)), String(bad.error).slice(0, 60));
check('reported the actual digest', bad.sha256 === installerSha);
check('refused to execute', /Refusing/u.test(String(bad.note)));
check('nothing ran', !existsSync(marker));

console.log('\n3. matching checksum runs the installer');
const good = await installMoli({ installerUrl, expectedSha256: installerSha, timeoutMs: 60000, locate: () => undefined });
check('installer executed', existsSync(marker), existsSync(marker) ? readFileSync(marker, 'utf8').trim() : 'no marker');
check('post-run discovery reported honestly', good.ok === false && /no working moli\.exe was found/u.test(String(good.error)), String(good.error).slice(0, 70));
check('digest survived', good.installerSha256 === installerSha);
check('manual fallback offered', typeof good.manualInstall?.powershell === 'string');

console.log('\n4. all-routes-fail diagnostics');
const dead = await downloadInstaller({
  target: join(mkdtempSync(join(tmpdir(), 'dsh-moli-dead-')), 'i.ps1'),
  installerUrl: 'http://127.0.0.1:9/none.ps1',
  timeoutMs: 15000,
  locate: () => undefined,
});
check('reported failure', dead.ok === false);
check('several routes tried', dead.attempts.length >= 2, `${dead.attempts.length}: ${dead.attempts.map(a => a.method).join(', ')}`);
check('each attempt explains itself', dead.attempts.every(a => a.ok === false && typeof a.error === 'string'), String(dead.attempts[0]?.error).slice(0, 50));

console.log('\n5. manual guidance');
check('powershell one-liner', /moli-installer\.ps1 \| iex/u.test(MANUAL_INSTALL.powershell));
check('shell one-liner', /moli-installer\.sh/u.test(MANUAL_INSTALL.shell));
check('checksum caveat stated', /no published checksum/u.test(MANUAL_INSTALL.verify));

console.log('\n6. sha256File');
check('hashes a real file', sha256File(join(pluginRoot, 'LICENSE')).length === 64);
check('matches an independently computed digest', sha256File(fixture) === installerSha);

server.kill();
if (existsSync(marker)) unlinkSync(marker);
console.log(`\nresult: ${pass} passed, ${fail} failed`);
process.exitCode = fail === 0 ? 0 : 1;
