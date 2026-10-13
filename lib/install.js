/**
 * Optional Moli bootstrap: fetch the official installer, report its SHA256, run
 * it, then confirm the engine actually answers.
 *
 * Why this is a fallback chain and not one download call: on the development
 * machine every single route to the GitHub release host failed at once — direct
 * `Invoke-WebRequest`, `Invoke-WebRequest` with an explicit proxy, `curl.exe`
 * with and without a proxy, and Moli itself. A one-shot download that reports
 * only "failed" leaves the user guessing, so each route is attempted in turn and
 * every outcome is reported.
 *
 * Two further constraints shape the code:
 *
 * - Verification is real but honest. The installer's SHA256 is computed and
 *   reported. When the caller supplies `expectedSha256`, a mismatch aborts before
 *   execution. Moli publishes no checksum file to compare against, so there is no
 *   default expectation to check — inventing one would be worse than reporting
 *   the digest that was actually run.
 * - Installation is never a side effect. It runs only when a tool call asks for
 *   it, because it downloads and executes third-party code.
 *
 * @module dsh-moli/lib/install
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync, existsSync, mkdtempSync, openSync, readFileSync, rmSync, statSync } from 'node:fs';
import { createConnection } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findMoli, moliVersion } from './moli.js';

/** Official installer for the latest release. */
export const INSTALLER_URL = 'https://github.com/lexmount/moli/releases/latest/download/moli-installer.ps1';

/** Moli's own README instructions, for the manual path. */
export const MANUAL_INSTALL = {
  powershell: 'powershell -ExecutionPolicy ByPass -c "irm https://github.com/lexmount/moli/releases/latest/download/moli-installer.ps1 | iex"',
  shell: 'curl --proto \'=https\' --tlsv1.2 -fsSL https://github.com/lexmount/moli/releases/latest/download/moli-installer.sh | sh',
  releases: 'https://github.com/lexmount/moli/releases/latest',
  verify: 'The installer has no published checksum; after downloading, compare its SHA256 against the digest this tool reports for the run that succeeded.',
};

/** PowerShell prelude that makes older hosts negotiate TLS 1.2. */
const TLS_PRELUDE = '[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12;';

/**
 * Check whether a forward proxy is actually accepting connections.
 *
 * A proxy setting can outlive the program that provided it: an accelerator that
 * writes a system proxy and is later closed leaves `ProxyEnable=1` pointing at a
 * dead port. Every command then sends each request to that port and waits for the
 * connect to time out — including requests to loopback. Probing first keeps the
 * fallback chain fast instead of spending a minute on routes that cannot work.
 *
 * @param proxy - proxy URL, e.g. `http://127.0.0.1:7890`.
 * @param timeoutMs - how long to wait for the connect.
 * @returns whether something is listening.
 */
export function proxyListens(proxy, timeoutMs = 700) {
  let host = '127.0.0.1';
  let port = 0;
  try {
    const parsed = new URL(proxy);
    host = parsed.hostname === '' ? host : parsed.hostname;
    port = Number(parsed.port);
  } catch {
    return false;
  }
  if (!Number.isInteger(port) || port <= 0) return false;
  return new Promise(resolve => {
    const socket = createConnection({ host, port });
    const settle = value => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(value);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => settle(true));
    socket.once('timeout', () => settle(false));
    socket.once('error', () => settle(false));
  });
}

/**
 * SHA256 a file, reading it whole (installer scripts are small).
 *
 * @param path - file to hash.
 * @returns the lowercase hex digest.
 */
export function sha256File(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

/**
 * Run one download attempt, treating a zero-byte file as failure.
 *
 * @param options - argv, environment, and the target path to check afterwards.
 * @returns the attempt outcome.
 */
function attempt(options) {
  const result = spawnSync(options.command, options.args, {
    stdio: ['ignore', 'ignore', 'pipe'],
    timeout: options.timeoutMs,
    windowsHide: true,
    env: options.env ?? process.env,
  });
  const failed = result.error !== undefined && result.error !== null;
  const exit = failed ? null : (result.status ?? 0);
  const bytes = existsSync(options.target) ? statSync(options.target).size : 0;
  const ok = !failed && exit === 0 && bytes > 0;
  // Keep the tail of stderr: a bare exit code cannot be acted on.
  const stderr = typeof result.stderr === 'string' ? result.stderr.trim().split('\n').slice(-2).join(' ').slice(0, 240) : '';
  return {
    method: options.method,
    ok,
    exit,
    bytes,
    error: ok
      ? undefined
      : failed
        ? `${result.error.code ?? 'spawn failed'}: ${result.error.message}`
        : exit === 0
          ? 'the download produced an empty file'
          : `exit ${String(exit)}${stderr === '' ? '' : `: ${stderr}`}`,
  };
}

/**
 * Try every available route to the installer, in order of least surprise.
 *
 * @param options - installer URL, target path, proxy, timeout, and injection points.
 * @returns the successful digest plus the full per-method log.
 */
export async function downloadInstaller(options) {
  const target = options.target;
  const url = options.installerUrl ?? INSTALLER_URL;
  const configured = typeof options.proxy === 'string' && options.proxy.length > 0 ? options.proxy : undefined;
  const timeoutMs = options.timeoutMs ?? 60000;
  const powershell = options.powershell ?? 'powershell.exe';

  // Never hand a loopback URL to a proxy — with a stale system proxy setting the
  // request would go to a dead port and wait out the connect timeout. Windows
  // PowerShell 5.1 has no `-NoProxy` on Invoke-WebRequest, and the system proxy is
  // read from the registry, so the only portable way to bypass it is to clear the
  // default proxy object for the process.
  const loopback = /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])/iu.test(url);
  const bypass = loopback ? ' [System.Net.WebRequest]::DefaultWebProxy = New-Object System.Net.WebProxy;' : '';
  const curlBypass = loopback ? ['--noproxy', '*'] : [];

  const iwr = extra => [
    '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command',
    `${TLS_PRELUDE}${bypass} Invoke-WebRequest -UseBasicParsing ${extra} -Uri '${url}' -OutFile $env:MOLI_DL_TARGET -TimeoutSec ${String(Math.ceil(timeoutMs / 1000))}`,
  ];

  const routes = [
    {
      method: 'Invoke-WebRequest (direct)',
      command: powershell,
      args: iwr(''),
    },
  ];

  // Only attempt proxy routes when something is actually listening there.
  let proxyAlive = false;
  if (configured !== undefined) {
    proxyAlive = await proxyListens(configured);
  }
  if (configured !== undefined && proxyAlive) {
    routes.push({
      method: `Invoke-WebRequest (proxy ${configured})`,
      command: powershell,
      args: iwr(`-Proxy '${configured}'`),
    });
  }
  routes.push({
    method: 'curl.exe (direct)',
    command: 'curl.exe',
    args: ['-sSL', ...curlBypass, '--max-time', String(Math.ceil(timeoutMs / 1000)), '-o', target, url],
  });
  if (configured !== undefined && proxyAlive) {
    routes.push({
      method: `curl.exe (proxy ${configured})`,
      command: 'curl.exe',
      args: ['-sSL', ...curlBypass, '--max-time', String(Math.ceil(timeoutMs / 1000)), '--proxy', configured, '-o', target, url],
    });
  }
  // Moli can bootstrap itself: when it is present but broken, or when reinstalling,
  // its own TLS handling is another independent route to the release host.
  const exe = options.locate === undefined ? undefined : options.locate(options.exePath);
  if (exe !== undefined) {
    routes.push({
      method: 'moli fetch (self-bootstrap)',
      command: exe,
      args: ['fetch', url, '--insecure-disable-tls-host-verification', ...(configured === undefined || !proxyAlive ? [] : ['--http-proxy', configured])],
      stdoutToFile: target,
    });
  }

  const log = [];
  for (const route of routes) {
    if (existsSync(target)) rmSync(target, { force: true });
    let outcome;
    if (route.stdoutToFile === undefined) {
      outcome = attempt({
        method: route.method,
        command: route.command,
        args: route.args,
        target,
        timeoutMs,
        env: { ...process.env, MOLI_DL_TARGET: target },
      });
    } else {
      // This route writes to stdout, so it needs the file descriptor treatment
      // rather than an --out argument.
      const fd = openSync(target, 'w');
      const result = spawnSync(route.command, route.args, { stdio: ['ignore', fd, 'ignore'], timeout: timeoutMs, windowsHide: true });
      closeSync(fd);
      const bytes = existsSync(target) ? statSync(target).size : 0;
      const failed = result.error !== undefined && result.error !== null;
      outcome = {
        method: route.method,
        ok: !failed && (result.status ?? 0) === 0 && bytes > 0,
        exit: failed ? null : (result.status ?? 0),
        bytes,
        error: failed ? `${result.error.code ?? 'spawn failed'}` : bytes === 0 ? 'empty output' : undefined,
      };
    }
    log.push({ method: outcome.method, ok: outcome.ok, bytes: outcome.bytes, error: outcome.error });
    if (outcome.ok) {
      return { ok: true, path: target, bytes: outcome.bytes, sha256: sha256File(target), method: outcome.method, attempts: log };
    }
  }
  return { ok: false, attempts: log, error: `every download route failed (${String(log.length)} tried)` };
}

/**
 * Install Moli and confirm it answers.
 *
 * @param options - expected checksum, timeouts, proxy, and injection points for tests.
 * @returns the settled outcome value.
 */
export async function installMoli(options = {}) {
  const timeoutMs = options.timeoutMs ?? 180000;
  const workDir = mkdtempSync(join(tmpdir(), 'dsh-moli-install-'));
  const target = join(workDir, 'moli-installer.ps1');
  try {
    const download = await downloadInstaller({
      target,
      installerUrl: options.installerUrl,
      proxy: options.proxy,
      timeoutMs: options.downloadTimeoutMs ?? 60000,
      locate: options.locate ?? findMoli,
      exePath: options.exePath,
    });

    if (download.ok !== true) {
      return {
        ok: false,
        error: download.error,
        attempts: download.attempts,
        note: 'No route to the release host worked. The manual install command below is the fallback.',
        manualInstall: MANUAL_INSTALL,
      };
    }

    // Verify before executing anything, whenever the caller states an expectation.
    if (typeof options.expectedSha256 === 'string' && options.expectedSha256.length > 0) {
      const expected = options.expectedSha256.trim().toLowerCase();
      if (expected !== download.sha256) {
        return {
          ok: false,
          error: `installer checksum mismatch: expected ${expected}, got ${download.sha256}`,
          sha256: download.sha256,
          expectedSha256: expected,
          method: download.method,
          note: 'Refusing to execute the installer.',
          manualInstall: MANUAL_INSTALL,
        };
      }
    }

    const run = spawnSync(options.powershell ?? 'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', target],
      { stdio: ['ignore', 'ignore', 'ignore'], timeout: timeoutMs, windowsHide: true });
    const runFailed = run.error !== undefined && run.error !== null;
    const runStatus = runFailed ? null : (run.status ?? 0);

    const locate = options.locate ?? findMoli;
    const exe = locate(options.exePath);
    const version = exe === undefined ? undefined : moliVersion(exe);

    if (version === undefined) {
      return {
        ok: false,
        error: runFailed
          ? `running the installer failed: ${run.error.message}`
          : `the installer ${runStatus === 0 ? 'reported success' : `exited ${String(runStatus)}`}, but no working moli.exe was found afterwards`,
        installerSha256: download.sha256,
        installerBytes: download.bytes,
        method: download.method,
        searchedPaths: options.candidates ?? undefined,
        manualInstall: MANUAL_INSTALL,
      };
    }

    return {
      ok: true,
      exe,
      version,
      installerSha256: download.sha256,
      installerBytes: download.bytes,
      method: download.method,
      note: 'Installed from the official release installer. The SHA256 above is what was actually run; Moli publishes no checksum file to compare it against.',
    };
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
}
