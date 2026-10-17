// Check whether this machine can actually `npm publish` before you try.
//
//   node scripts/preflight-publish.mjs
//
// Exit 0 = the credential authenticates and this package can be published.
// Exit 1 = it cannot, and the message says which failure it is.
//
// Why this exists: npm answers an authorisation failure on PUT with
//
//   E404 Not Found - PUT https://registry.npmjs.org/dsh-moli
//        The requested resource 'dsh-moli@1.1.17' could not be found or you do
//        not have permission to access it.
//
// which reads as a missing package and sends you looking for a packaging problem
// that is not there. The real causes are a dead token, a token without write
// access, or a version that is already published. This tells them apart in one
// command, and it needs no network round trip once the local config is read.
//
// Publishing manually is the intended path for this package; the OIDC workflow in
// .github/workflows/publish.yml is the fallback for when a local credential is gone.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = dirname(here);
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));

let failed = false;
const check = (label, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${detail ? ' -- ' + detail : ''}`);
  if (!ok) failed = true;
};

// npm lives beside the running node binary; spawning a bare `npm.cmd` fails at
// Node 20+ with EINVAL, which is why this goes through the CLI script.
function npm(args, timeout = 60000) {
  const cli = join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
  const command = existsSync(cli) ? [process.execPath, [cli, ...args]] : ['npm', args];
  try {
    const out = execFileSync(command[0], command[1], { encoding: 'utf8', timeout, stdio: ['ignore', 'pipe', 'pipe'] });
    return { ok: true, out: String(out).trim(), err: '' };
  } catch (error) {
    return { ok: false, out: String(error.stdout ?? '').trim(), err: String(error.stderr ?? error.message) };
  }
}

console.log(`package : ${pkg.name}@${pkg.version}`);
console.log(`registry: ${String(pkg.publishConfig?.registry ?? '(default)')}\n`);

// 1. The tarball that would be uploaded. No credential needed, so this runs first.
const pack = npm(['pack', '--dry-run', '--json'], 120000);
if (pack.ok) {
  const files = JSON.parse(pack.out)[0]?.files?.length ?? 0;
  check('the package builds and lists its files', files > 0, `${String(files)} files`);
} else {
  check('the package builds', false, pack.err.split('\n')[0]);
}

// 2. The credential. `whoami` is the one call that separates "no auth" from
//    "wrong package", because it fails for auth reasons only.
const who = npm(['whoami'], 45000);
if (who.ok && who.out !== '') {
  check('the npm credential authenticates', true, who.out);
} else if (/E401|ENEEDAUTH|Unauthorized|unauthorized/iu.test(who.err)) {
  check('the npm credential authenticates', false,
    'E401 -- there is no usable token. Run `npm login`, or set a granular access token '
    + '(read-write, this package) in your user .npmrc. A publish attempt would have reported E404 instead.');
} else {
  check('the npm credential authenticates', false, who.err.split('\n')[0]);
}

// 3. Whether that version is already taken. A published version cannot be
//    overwritten, and npm reports the refusal in the same 404 shape.
//
// Read from the registry over HTTPS rather than `npm view`: that command goes
// through the configured credential, so with a dead token it fails for auth
// reasons and this check would blame the version instead. Version metadata is
// public, so the authenticated path buys nothing here.
const registry = String(pkg.publishConfig?.registry ?? 'https://registry.npmjs.org').replace(/\/$/u, '');
try {
  const response = await fetch(`${registry}/${encodeURIComponent(pkg.name)}/${encodeURIComponent(pkg.version)}`, {
    headers: { accept: 'application/json' },
    signal: AbortSignal.timeout(20000),
  });
  // Drain the body so the socket is released.
  await response.text();
  if (response.status === 200) {
    check('the version is still free', false, `${pkg.version} is already published; bump package.json first`);
  } else if (response.status === 404) {
    check('the version is still free', true, `${pkg.version} is not on the registry`);
  } else {
    check('the version is still free', false, `the registry answered HTTP ${String(response.status)}`);
  }
} catch (error) {
  check('the version is still free', false, `could not reach the registry: ${String(error.message).split('\n')[0]}`);
}

console.log('');
if (failed) {
  console.log('Not safe to publish yet. Fix the FAILs above.');
  console.log('If the credential is the problem, the OIDC workflow is the fallback that needs none:');
  console.log('  Actions -> publish -> Run workflow');
  // `process.exitCode` rather than `process.exit()`: exiting from inside an async
  // body while a fetch socket is still open trips a libuv assertion on Windows
  // (`!(handle->flags & UV_HANDLE_CLOSING)`), which crashed this script with a
  // stack trace instead of printing its own verdict.
  process.exitCode = 1;
} else {
  console.log(`Safe to publish. From this directory:\n\n  npm publish\n\nThen tag the release:\n\n  git tag v${pkg.version} && git push origin v${pkg.version}`);
}
