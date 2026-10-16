// Preflight before `npm publish`: report whether this machine can actually
// publish, instead of letting npm answer with a 404 that reads like a missing
// package.
//
//   node scripts/preflight-publish.mjs [registry]
//
// Exit 0 = safe to publish. Exit 1 = the credential is dead or read-only; the
// message says which, and what to do about it.
//
// Why this exists: npm masks an authorisation failure on PUT with
//   E404 ... 'dsh-moli@1.1.5' could not be found or you do not have permission
// which sends you looking for a package problem that is not there. The token was
// simply expired. `npm whoami` catches that, but only if it is run with the same
// registry the publish targets, and only if a stale token in a config file is not
// shadowing it.
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const registry = (process.argv[2] ?? 'https://registry.npmjs.org').replace(/\/+$/u, '');

/** Tokens are never printed; only their shape. */
function storedToken() {
  const file = join(process.env.USERPROFILE ?? process.env.HOME ?? '', '.npmrc');
  if (!existsSync(file)) return undefined;
  const line = readFileSync(file, 'utf8').split('\n').map(l => l.trim())
    .find(l => /_authToken\s*=/u.test(l) && l.includes(registry.replace(/^https?:/u, '')));
  if (line === undefined) return undefined;
  return line.slice(line.indexOf('=') + 1).trim();
}

function whoami() {
  const r = spawnSync(process.platform === 'win32' ? 'npm.cmd' : 'npm',
    ['whoami', '--registry', registry],
    { encoding: 'utf8', timeout: 60000, windowsHide: true, shell: process.platform === 'win32' });
  const out = String(r.stdout ?? '').trim();
  const err = String(r.stderr ?? '').trim();
  return { status: r.status, out, err: err.split('\n').slice(0, 4).join(' | ') };
}

console.log(`registry : ${registry}`);

const token = storedToken();
if (token === undefined) {
  console.log('token    : none stored for this registry (expected when publishing through OIDC in CI)');
} else {
  console.log(`token    : ${String(token.length)} chars, prefix ${token.slice(0, 8)}…`);
}

const me = whoami();
if (me.status === 0 && me.out !== '') {
  console.log(`whoami   : ${me.out}`);
  console.log('\nOK: this machine can authenticate. `npm publish` should be accepted.');
  process.exit(0);
}

console.log('whoami   : FAILED');
if (me.err !== '') console.log(`           ${me.err.slice(0, 200)}`);

console.log('\nThis machine cannot publish. npm will answer the PUT with E404 and a');
console.log('"could not be found or you do not have permission" message, which is an');
console.log('authorisation failure wearing the wrong error code. Fix one of:\n');
console.log('  a) publish from CI instead (no credential to expire) -- see');
console.log('     .github/workflows/publish.yml and configure the trusted publisher on npmjs.com');
console.log('  b) create a new token on npmjs.com and store it:');
console.log(`       npm config set "${registry.replace(/^https?:/u, '')}/:_authToken" <token>`);
console.log('\nNote that npm is retiring tokens which bypass 2FA, so a classic token may be');
console.log('revoked again; the OIDC path in (a) does not use one.');
process.exit(1);
