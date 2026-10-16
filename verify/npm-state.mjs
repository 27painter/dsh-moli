// Inspect the published dsh-moli package state precisely.
import { spawnSync } from 'node:child_process';
import { openSync, closeSync, readFileSync, existsSync, unlinkSync, mkdtempSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// This script runs at publish time on the server, which is POSIX, so it cannot
// hard-code LOCALAPPDATA (undefined there — path.join would throw). Resolve the
// engine through the plugin's own cross-platform findMoli and fall back to the
// platform's home layout, like lib/moli.js itself does.
const REPO = fileURLToPath(new URL('..', import.meta.url));
const { findMoli } = await import(join(REPO, 'lib', 'moli.js'));
const exe = findMoli(undefined)
  ?? (process.platform === 'win32'
    ? join(process.env.LOCALAPPDATA ?? '', 'Moli', 'bin', 'moli.exe')
    : join(homedir(), '.local', 'bin', 'moli'));

function fetchJson(url) {
  // A unique file in the OS temp dir: a fixed 'pkg.tmp' in the cwd collides
  // across parallel runs and litters the tree.
  const dir = mkdtempSync(join(tmpdir(), 'dsh-moli-npm-state-'));
  const out = join(dir, 'capture.json');
  const fd = openSync(out, 'w');
  const r = spawnSync(exe, ['fetch', url, '-d', 'json', '--insecure-disable-tls-host-verification', '-t', '45000'],
    { stdio: ['ignore', fd, 'ignore'], timeout: 90000 });
  closeSync(fd);
  const text = existsSync(out) ? readFileSync(out, 'utf8') : '';
  if (existsSync(out)) unlinkSync(out);
  if (r.status !== 0) return { error: `moli exit ${r.status}` };
  const outer = JSON.parse(text);
  if (outer.status !== 200) return { status: outer.status };
  const html = String(outer.html ?? '');
  const pre = /<pre[^>]*>([\s\S]*?)<\/pre>/u.exec(html);
  const raw = (pre ? pre[1] : html)
    .replace(/&quot;/gu, '"').replace(/&#39;/gu, "'")
    .replace(/&lt;/gu, '<').replace(/&gt;/gu, '>').replace(/&amp;/gu, '&');
  return { data: JSON.parse(raw) };
}

const doc = fetchJson('https://registry.npmjs.org/dsh-moli');
if (doc.error || doc.status) {
  console.log('registry read failed:', JSON.stringify(doc));
  process.exit(1);
}
const p = doc.data;

console.log('dist-tags:', JSON.stringify(p['dist-tags']));
console.log('all versions:', Object.keys(p.versions).join(', '));
console.log('time:', JSON.stringify(p.time, null, 1));

console.log('\n--- 1.0.0 manifest ---');
const one = p.versions['1.0.0'];
if (!one) {
  console.log('1.0.0 NOT in registry versions');
} else {
  console.log('version      :', one.version);
  console.log('description  :', one.description);
  console.log('license      :', one.license);
  console.log('author       :', JSON.stringify(one.author));
  console.log('repository   :', JSON.stringify(one.repository));
  console.log('dsh.bundle   :', JSON.stringify(one.dsh?.bundle ?? null));
  console.log('main/exports :', JSON.stringify(one.exports ?? one.main ?? null));
  console.log('dist.tarball :', one.dist.tarball);
  console.log('dist.shasum  :', one.dist.shasum);
  console.log('dist.integrity:', String(one.dist.integrity).slice(0, 40));
  console.log('unpackedSize :', one.dist.unpackedSize ?? '(not reported)');
  console.log('fileCount    :', one.dist.fileCount ?? '(not reported)');
  console.log('files field  :', JSON.stringify(one.files ?? null));
}

console.log('\n--- 0.0.0-stage manifest ---');
const stage = p.versions['0.0.0-stage'];
console.log(stage ? JSON.stringify({ version: stage.version, description: stage.description, dsh: stage.dsh ?? null, dist: stage.dist?.tarball }, null, 1) : '(absent)');
