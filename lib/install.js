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
 * Every long-running step runs through {@link runAsync}: a child process is
 * spawned without blocking the event loop, the caller awaits its `close` event,
 * and a timeout or abort signal kills it. The DSH host keeps serving requests
 * while an install is in flight — including the official installer's own
 * engine download, which can hang for a long time when the release host is
 * unreachable without a proxy.
 *
 * Proxy handling is centralized at the head of this module (see the "Unified
 * forward-proxy behaviour" section) and the platform decides how the official
 * installer is fed that proxy: POSIX gets proxy environment variables (curl
 * reads them), Windows gets a DefaultWebProxy prelude (Invoke-WebRequest reads
 * that instead).
 *
 * @module dsh-moli/lib/install
 */
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync, existsSync, mkdtempSync, openSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { createConnection } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { findMoli } from './moli.js';

/** Official installer for the latest release. */
export const INSTALLER_URL = process.platform === 'win32'
  ? 'https://github.com/lexmount/moli/releases/latest/download/moli-installer.ps1'
  : 'https://github.com/lexmount/moli/releases/latest/download/moli-installer.sh';

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
 * Unified forward-proxy behaviour for this pipeline.
 *
 * Every proxy decision — parsing/validation, liveness probing, curl argv, the
 * PowerShell DefaultWebProxy prelude, and the child-process environment for the
 * official installer — lives here, so the download routes and (later) the
 * installer execution always agree on one proxy configuration instead of
 * re-deriving it in each spot.
 *
 * The platforms disagree about how a proxy is honoured, and that fact is
 * encoded here:
 *
 * - Linux / macOS — `curl` (used inside moli-installer.sh) reads the standard
 *   `HTTPS_PROXY` / `HTTP_PROXY` / `ALL_PROXY` environment variables, so
 *   injecting them into the installer's child process is enough.
 * - Windows — `Invoke-WebRequest` (used inside moli-installer.ps1) does NOT
 *   read those variables; it honours the WinINET system proxy, i.e. .NET's
 *   `DefaultWebProxy`, so the installer must be preceded by a prelude that
 *   sets that object.
 */

/** Resolve a proxy URL into a structured configuration; undefined when unusable. */
function resolveProxy(input) {
  if (typeof input !== 'string' || input.length === 0) return undefined;
  let parsed;
  try {
    parsed = new URL(input);
  } catch {
    return undefined;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return undefined;
  const host = parsed.hostname === '' ? undefined : parsed.hostname;
  // A proxy URL without an explicit port uses the scheme default (http 80,
  // https 443); a bare `http://proxy` would otherwise parse as port 0 and be
  // silently discarded while proxyListens probes port 80 for the same string.
  const port = parsed.port === ''
    ? (parsed.protocol === 'https:' ? 443 : 80)
    : Number(parsed.port);
  if (host === undefined || !Number.isInteger(port) || port <= 0 || port > 65535) return undefined;
  return {
    url: input,
    scheme: parsed.protocol.slice(0, -1),
    host,
    port,
    auth: parsed.username !== '' || parsed.password !== ''
      ? { user: decodeURIComponent(parsed.username), pass: decodeURIComponent(parsed.password) }
      : undefined,
  };
}

/** Whether a URL targets loopback and must never be handed to a proxy. */
function isLoopbackUrl(url) {
  return /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])/iu.test(url);
}

/** curl argv that routes a download through the proxy. */
function curlProxyArgs(proxy) {
  const config = resolveProxy(proxy);
  return config === undefined ? [] : ['--proxy', config.url];
}

/** curl argv that keeps a direct route off the proxy (loopback only). */
function curlBypassArgs(url) {
  return isLoopbackUrl(url) ? ['--noproxy', '*'] : [];
}

/**
 * PowerShell prelude that clears the default web proxy for a loopback download.
 *
 * PowerShell 5.1's `Invoke-WebRequest` has no `-NoProxy`, and the system proxy
 * is read from the registry, so the only portable way to bypass it is to clear
 * the default proxy object for the process.
 *
 * @param loopback - whether the target URL is loopback.
 * @returns the PowerShell statement, or an empty string when not needed.
 */
function powershellProxyBypass(loopback) {
  return loopback
    ? '[System.Net.WebRequest]::DefaultWebProxy = New-Object System.Net.WebProxy;'
    : '';
}

/**
 * PowerShell prelude that makes `Invoke-WebRequest` route through a proxy.
 *
 * `IWR` ignores `HTTPS_PROXY`/`HTTP_PROXY` environment variables; it honours
 * the WinINET system proxy, i.e. .NET's `DefaultWebProxy`. Setting that object
 * before running moli-installer.ps1 is what actually makes the Windows
 * installer's internal engine download honour the configured proxy. When the
 * proxy URL carries credentials, they are assigned explicitly as well: the
 * `WebProxy` constructor does parse userinfo in the address, but an explicit
 * `NetworkCredential` is the unambiguous form.
 *
 * @param proxy - proxy URL.
 * @returns the PowerShell statement, or an empty string when absent.
 */
export function powershellProxyPrelude(proxy) {
  const config = resolveProxy(proxy);
  if (config === undefined) return '';
  const esc = value => value.replace(/'/gu, "''");
  let prelude = `$__dshMoliProxy = New-Object System.Net.WebProxy('${esc(config.url)}');`;
  if (config.auth !== undefined) {
    prelude += `$__dshMoliProxy.Credentials = New-Object System.Net.NetworkCredential('${esc(config.auth.user)}', '${esc(config.auth.pass)}');`;
  }
  prelude += `[System.Net.WebRequest]::DefaultWebProxy = $__dshMoliProxy;`;
  return prelude;
}

/**
 * Environment variables that make curl (inside moli-installer.sh) route
 * through the proxy.
 *
 * Both cases are set because the tools disagree about which form they read:
 * Windows builds of curl recognise the upper-case names, POSIX tools the
 * lower-case ones.
 *
 * @param proxy - proxy URL.
 * @returns an object to spread into the child's `env`; empty when absent.
 */
export function proxyEnv(proxy) {
  const config = resolveProxy(proxy);  if (config === undefined) return {};
  return {
    HTTPS_PROXY: config.url,
    HTTP_PROXY: config.url,
    https_proxy: config.url,
    http_proxy: config.url,
    ALL_PROXY: config.url,
    all_proxy: config.url,
  };
}

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
  const config = resolveProxy(proxy);
  if (config === undefined) return Promise.resolve(false);
  return new Promise(resolve => {
    const socket = createConnection({ host: config.host, port: config.port });
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
 * Normalize stderr text into one readable line.
 *
 * Keep the leading meaningful lines and drop control bytes so the message
 * survives a JSON round trip.
 *
 * @param text - raw stderr text.
 * @returns the condensed message.
 */
function condenseStderr(text) {
  return String(text)
    .replace(/\u001b\[[0-9;]*m/gu, '')
    .replace(/\r/gu, '')
    .split('\n')
    .map(line => line.trim())
    .filter(line => line.length > 0)
    .slice(0, 6)
    .join(' | ');
}

/**
 * Kill a process and everything it spawned.
 *
 * The process that actually does the work — the installer's internal engine
 * download — is a grandchild: POSIX spawns `sh`, which runs `moli-installer.sh`,
 * which runs `curl`; Windows spawns `powershell.exe -Command "... & script.ps1"`
 * and the `Invoke-WebRequest` inside the script does the download. Killing only
 * the direct child would leak that download: the plugin would report a timeout
 * or abort while the installer kept pulling the ~100 MB engine in the temp dir.
 *
 * - POSIX: spawn with `detached: true` makes the child a process-group leader,
 *   so a negative pid signal reaches the whole group.
 * - Windows: there is no process group to signal, so `taskkill /T` walks the
 *   tree instead.
 *
 * @param child - the direct child process.
 * @param signal - SIGTERM or SIGKILL (POSIX only; Windows always force-kills).
 */
function killTree(child, signal) {
  if (child === undefined || child.pid === undefined) return;
  if (process.platform === 'win32') {
    try {
      spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true, timeout: 10000 });
    } catch { /* best effort */ }
    return;
  }
  try { process.kill(-child.pid, signal); } catch { /* best effort */ }
  // Fall back to the direct child in case the group kill did not reach it.
  try { child.kill(signal); } catch { /* best effort */ }
}

/**
 * Run one command asynchronously, never blocking the event loop.
 *
 * stdout and stderr go to real files (the plugin's existing sandbox discipline:
 * a child under DSH's Windows sandbox cannot open inherited pipes, so pipe
 * capture is unreliable), and the caller awaits the `close` event. A timeout
 * sends SIGTERM then SIGKILL to the whole process group; an abort signal kills
 * immediately. The caller's event loop keeps serving while the child runs —
 * including the official installer's internal engine download, which can hang
 * without a proxy.
 *
 * @param options - command, argv, env, timeout, optional stdout file, abort signal.
 * @returns the settled outcome; never throws for a non-zero exit.
 */
function runAsync(options) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-moli-run-'));
  const outPath = options.stdoutFile ?? join(dir, 'stdout.bin');
  const errPath = join(dir, 'stderr.txt');
  let outFd;
  let errFd;
  let timer;
  let child;
  let settled = false;

  const settle = value => {
    if (settled) return;
    settled = true;
    if (timer !== undefined) clearTimeout(timer);
    if (child !== undefined) child.removeAllListeners();
    if (outFd !== undefined) closeSync(outFd);
    if (errFd !== undefined) closeSync(errFd);
    outFd = undefined;
    errFd = undefined;
    const stdout = existsSync(outPath) ? readFileSync(outPath) : Buffer.alloc(0);
    const stderrText = existsSync(errPath) ? readFileSync(errPath, 'utf8') : '';
    rmSync(dir, { recursive: true, force: true });
    resolve({ status: value.status, spawnError: value.spawnError, stdout, stderr: stderrText });
  };

  // Promise executor cannot be async; the resolve is captured via closure.
  let resolve;
  const promise = new Promise(r => { resolve = r; });

  try {
    outFd = openSync(outPath, 'w');
    errFd = openSync(errPath, 'w');
  } catch (error) {
    rmSync(dir, { recursive: true, force: true });
    resolve({ status: null, stdout: Buffer.alloc(0), stderr: '', spawnError: `open failed: ${error.message}` });
    return promise;
  }

  try {
    child = spawn(options.command, options.args, {
      stdio: ['ignore', outFd, errFd],
      env: options.env ?? process.env,
      windowsHide: true,
      // POSIX: the child becomes a process-group leader so killTree can reach
      // the whole tree (sh → moli-installer.sh → curl) with one negative-pid
      // signal. Windows must NOT detach: a detached console child's stdio
      // handles become invalid and powershell.exe exits 0 without running its
      // command, so killTree force-kills there via taskkill /T /F, which needs
      // no detach at all.
      detached: process.platform !== 'win32',
    });
  } catch (error) {
    settle({ status: null, stdout: Buffer.alloc(0), stderr: '', spawnError: `${error.code ?? 'spawn failed'}: ${error.message}` });
    return promise;
  }

  child.once('error', error => settle({
    status: null,
    stdout: Buffer.alloc(0),
    stderr: '',
    spawnError: `${error.code ?? 'spawn failed'}: ${error.message}`,
  }));
  child.once('close', code => settle({
    status: code ?? 0,
    stdout: Buffer.alloc(0), // populated by settle from the file
    stderr: '',
  }));

  const timeoutMs = options.timeoutMs;
  if (timeoutMs !== undefined) {
    timer = setTimeout(() => {
      if (settled || child === undefined) return;
      killTree(child, 'SIGTERM');
      // Give the tree a short grace period, then force it.
      const killer = setTimeout(() => {
        if (!settled && child !== undefined) {
          killTree(child, 'SIGKILL');
        }
      }, 2000);
      killer.unref?.();
    }, timeoutMs);
  }

  if (options.signal !== undefined && options.signal !== null) {
    if (options.signal.aborted === true) {
      killTree(child, 'SIGKILL');
    } else {
      options.signal.addEventListener('abort', () => {
        if (!settled && child !== undefined) {
          killTree(child, 'SIGKILL');
        }
      }, { once: true });
    }
  }

  return promise;
}

/**
 * Run one command synchronously, blocking until it exits.
 *
 * This is the Windows path's runner: Windows is deliberately not
 * asynchronized (its installer has bounded `Invoke-WebRequest` timeouts and
 * the platform was not part of the Linux hang investigation), so the whole
 * install stays synchronous there. stdout and stderr still go to real files —
 * under DSH's Windows sandbox a child cannot open inherited pipes — and the
 * caller gets the file contents read back.
 *
 * @param options - command, argv, env, timeout, optional stdout file.
 * @returns the settled outcome; never throws for a non-zero exit.
 */
function runSync(options) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-moli-run-'));
  const outPath = options.stdoutFile ?? join(dir, 'stdout.bin');
  const errPath = join(dir, 'stderr.txt');
  let outFd;
  let errFd;
  try {
    outFd = openSync(outPath, 'w');
    errFd = openSync(errPath, 'w');
    const result = spawnSync(options.command, options.args, {
      stdio: ['ignore', outFd, errFd],
      env: options.env ?? process.env,
      timeout: options.timeoutMs,
      windowsHide: true,
    });
    const stdout = existsSync(outPath) ? readFileSync(outPath) : Buffer.alloc(0);
    const stderrText = existsSync(errPath) ? readFileSync(errPath, 'utf8') : '';
    const failed = result.error !== undefined && result.error !== null;
    return {
      status: failed ? null : (result.status ?? 0),
      stdout,
      stderr: condenseStderr(stderrText),
      spawnError: failed ? `${result.error.code ?? 'spawn failed'}: ${result.error.message}` : undefined,
    };
  } finally {
    if (outFd !== undefined) closeSync(outFd);
    if (errFd !== undefined) closeSync(errFd);
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Run one download attempt, treating a zero-byte file as failure.
 *
 * @param options - argv, environment, and the target path to check afterwards.
 * @returns the attempt outcome.
 */
async function attempt(options) {
  const outcome = await runAsync({
    command: options.command,
    args: options.args,
    env: options.env,
    timeoutMs: options.timeoutMs,
  });
  const bytes = existsSync(options.target) ? statSync(options.target).size : 0;
  const failed = outcome.spawnError !== undefined;
  const exit = failed ? null : outcome.status;
  const ok = !failed && exit === 0 && bytes > 0;
  return {
    method: options.method,
    ok,
    exit,
    bytes,
    error: ok
      ? undefined
      : failed
        ? outcome.spawnError
        : exit === 0
          ? 'the download produced an empty file'
          : `exit ${String(exit)}${outcome.stderr === '' ? '' : `: ${outcome.stderr}`}`,
  };
}

/**
 * Run a stdout-producing download route (the moli self-bootstrap) to the target.
 *
 * @param route - the route descriptor with `command` and `args`.
 * @param target - the file the child's stdout is written to.
 * @param timeoutMs - download deadline.
 * @returns the attempt outcome.
 */
async function attemptStdout(route, target, timeoutMs) {
  const outcome = await runAsync({
    command: route.command,
    args: route.args,
    env: { ...process.env, MOLI_DL_TARGET: target },
    timeoutMs,
    stdoutFile: target,
  });
  const bytes = existsSync(target) ? statSync(target).size : 0;
  const failed = outcome.spawnError !== undefined;
  const ok = !failed && outcome.status === 0 && bytes > 0;
  return {
    method: route.method,
    ok,
    exit: failed ? null : outcome.status,
    bytes,
    error: ok
      ? undefined
      : failed
        ? outcome.spawnError
        : bytes === 0
          ? 'empty output'
          : `exit ${String(outcome.status)}`,
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
  const timeoutMs = options.timeoutMs ?? 60000;
  const powershell = options.powershell ?? (process.platform === 'win32' ? 'powershell.exe' : 'powershell');
  const onWindows = process.platform === 'win32';

  // Head: one proxy decision, then every route below agrees on it.
  const proxyConfig = resolveProxy(options.proxy);
  const proxyAlive = proxyConfig === undefined ? false : await proxyListens(proxyConfig.url);
  const proxy = proxyConfig === undefined ? undefined : proxyConfig.url;

  // Never hand a loopback URL to a proxy — with a stale system proxy setting the
  // request would go to a dead port and wait out the connect timeout. Windows
  // PowerShell 5.1 has no `-NoProxy` on Invoke-WebRequest, and the system proxy is
  // read from the registry, so the only portable way to bypass it is to clear the
  // default proxy object for the process.
  const bypass = powershellProxyBypass(isLoopbackUrl(url));

  const iwr = extra => [
    '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command',
    `${TLS_PRELUDE}${bypass} Invoke-WebRequest -UseBasicParsing ${extra} -Uri '${url}' -OutFile $env:MOLI_DL_TARGET -TimeoutSec ${String(Math.ceil(timeoutMs / 1000))}`,
  ];

  // Route order is platform-aware, in order of least surprise.
  const routes = [];
  if (onWindows) {
    routes.push({
      method: 'Invoke-WebRequest (direct)',
      command: powershell,
      args: iwr(''),
    });
    // Only attempt proxy routes when something is actually listening there.
    if (proxy !== undefined && proxyAlive) {
      routes.push({
        method: `Invoke-WebRequest (proxy ${proxy})`,
        command: powershell,
        args: iwr(`-Proxy '${proxy}'`),
      });
    }
  }
  routes.push({
    method: 'curl (direct)',
    command: onWindows ? 'curl.exe' : 'curl',
    args: ['-sSL', ...curlBypassArgs(url), '--max-time', String(Math.ceil(timeoutMs / 1000)), '-o', target, url],
  });
  if (proxy !== undefined && proxyAlive) {
    routes.push({
      method: `curl (proxy ${proxy})`,
      command: onWindows ? 'curl.exe' : 'curl',
      args: ['-sSL', ...curlBypassArgs(url), '--max-time', String(Math.ceil(timeoutMs / 1000)), ...curlProxyArgs(proxy), '-o', target, url],
    });
  }
  // Moli can bootstrap itself: when it is present but broken, or when reinstalling,
  // its own TLS handling is another independent route to the release host.
  const exe = options.locate === undefined ? undefined : options.locate(options.exePath);
  if (exe !== undefined) {
    routes.push({
      method: 'moli fetch (self-bootstrap)',
      command: exe,
      args: ['fetch', url, '--insecure-disable-tls-host-verification', ...(proxy === undefined || !proxyAlive ? [] : ['--http-proxy', proxy])],
      stdoutToFile: true,
    });
  }

  const log = [];
  for (const route of routes) {
    if (existsSync(target)) rmSync(target, { force: true });
    // Every route runs asynchronously on every platform: the child process is
    // spawned without blocking the DSH host's event loop, and the per-route
    // timeout keeps a hung download from stalling the host. Windows and POSIX
    // behave identically here.
    const outcome = route.stdoutToFile === undefined
      ? await attempt({
          method: route.method,
          command: route.command,
          args: route.args,
          target,
          timeoutMs,
          env: { ...process.env, MOLI_DL_TARGET: target },
        })
      : await attemptStdout(route, target, timeoutMs);
    log.push({ method: outcome.method, ok: outcome.ok, bytes: outcome.bytes, error: outcome.error });
    if (outcome.ok) {
      return { ok: true, path: target, bytes: outcome.bytes, sha256: sha256File(target), method: outcome.method, attempts: log };
    }
  }
  return { ok: false, attempts: log, error: `every download route failed (${String(log.length)} tried)` };
}

/**
 * Read the engine's version banner asynchronously.
 *
 * @param exe - absolute path to the moli binary.
 * @param options - timeout and abort signal.
 * @returns the version string, or undefined when the call failed.
 */
async function moliVersionAsync(exe, options = {}) {
  const outcome = await runAsync({
    command: exe,
    args: ['--version'],
    timeoutMs: options.timeoutMs ?? 15000,
    signal: options.signal,
  });
  if (outcome.status !== 0 || outcome.spawnError !== undefined) return undefined;
  const text = outcome.stdout.toString('utf8').trim();
  return text === '' ? undefined : text;
}

/**
 * Synchronous twin of {@link moliVersionAsync}, used on Windows.
 *
 * @param exe - absolute path to the moli binary.
 * @param timeoutMs - version-call deadline.
 * @returns the version string, or undefined when the call failed.
 */
function moliVersionSync(exe, timeoutMs = 15000) {
  const outcome = runSync({ command: exe, args: ['--version'], timeoutMs });
  if (outcome.status !== 0 || outcome.spawnError !== undefined) return undefined;
  const text = outcome.stdout.toString('utf8').trim();
  return text === '' ? undefined : text;
}

/**
 * Install Moli and confirm it answers.
 *
 * @param options - expected checksum, timeouts, proxy, abort signal, and injection points for tests.
 * @returns the settled outcome value.
 */
export async function installMoli(options = {}) {
  const timeoutMs = options.timeoutMs ?? 180000;
  const workDir = mkdtempSync(join(tmpdir(), 'dsh-moli-install-'));
  const target = join(workDir, process.platform === 'win32' ? 'moli-installer.ps1' : 'moli-installer.sh');
  try {
    // Head: one proxy decision, shared by the download below and the run after it.
    const proxyConfig = resolveProxy(options.proxy);
    const proxyAlive = proxyConfig === undefined ? false : await proxyListens(proxyConfig.url);
    const proxy = proxyConfig === undefined ? undefined : proxyConfig.url;

    const download = await downloadInstaller({
      target,
      installerUrl: options.installerUrl,
      proxy,
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
          installerSha256: download.sha256,
          expectedSha256: expected,
          method: download.method,
          note: 'Refusing to execute the installer.',
          manualInstall: MANUAL_INSTALL,
        };
      }
    }

    // Run the official installer, routing its internal engine download through
    // the proxy the way each platform honours it:
    // - POSIX (Linux/macOS): moli-installer.sh uses curl, which reads the proxy
    //   environment variables, so injecting them is enough.
    // - Windows: moli-installer.ps1 uses Invoke-WebRequest, which ignores env
    //   variables and honours .NET's DefaultWebProxy, so the script must be
    //   preceded by a prelude that sets that object.
    const env = { ...process.env, ...(proxyAlive ? proxyEnv(proxy) : {}) };
    let args;
    if (process.platform === 'win32') {
      const prelude = `${TLS_PRELUDE}${proxyAlive ? powershellProxyPrelude(proxy) : ''}`;
      const script = `& '${target.replace(/'/gu, "''")}'`;
      args = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', `${prelude} ${script}`];
    } else {
      args = [target];
    }
    let run;
    if (process.platform === 'win32') {
      // Windows runs asynchronously too: spawn the installer without blocking
      // the DSH host's event loop. The outer timeout sends SIGTERM then
      // SIGKILL, and an abort signal kills it immediately, so the host keeps
      // serving requests while PowerShell's Invoke-WebRequest does its work.
      run = await runAsync({
        command: options.powershell ?? 'powershell.exe',
        args,
        env,
        timeoutMs,
        signal: options.signal,
      });
    } else {
      // Linux/macOS keeps its existing asynchronous behaviour.
      run = await runAsync({
        command: 'sh',
        args,
        env,
        timeoutMs,
        signal: options.signal,
      });
    }
    const runFailed = run.spawnError !== undefined;
    const runStatus = runFailed ? null : run.status;

    const locate = options.locate ?? findMoli;
    const exe = locate(options.exePath);
    const version = exe === undefined
      ? undefined
      : process.platform === 'win32'
        ? moliVersionSync(exe)
        : await moliVersionAsync(exe, { signal: options.signal });

    if (version === undefined) {
      return {
        ok: false,
        error: runFailed
          ? `running the installer failed: ${run.spawnError}`
          : `the installer ${runStatus === 0 ? 'reported success' : `exited ${String(runStatus)}`}, but no working moli binary was found afterwards`,
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

/**
 * Remove an installed Moli engine. Windows deletes the installer-owned
 * `%LOCALAPPDATA%\Moli` tree; POSIX removes the located binary and prunes the
 * install directories it sits in when they end up empty.
 *
 * @param override - explicit path from configuration, when set.
 * @returns the removed path, or undefined when nothing was installed.
 */
export function uninstallMoli(override) {
  const exe = findMoli(override);
  if (exe === undefined) return undefined;
  if (process.platform === 'win32') {
    const root = process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, 'Moli') : undefined;
    if (root !== undefined && existsSync(root)) {
      rmSync(root, { recursive: true, force: true });
      return root;
    }
    // No installer-owned tree: nothing to remove. Returning here keeps the
    // uninstall from falling through to the POSIX branch and deleting whatever
    // findMoli located — which could be a user-provided path or a test fixture.
    return undefined;
  }
  rmSync(exe, { force: true });
  const dir = dirname(exe);
  for (const parent of [dir, dirname(dir)]) {
    try {
      if (existsSync(parent) && readdirSync(parent).length === 0) rmSync(parent, { force: true });
    } catch {
      // A non-empty or protected parent is fine; the binary is already gone.
    }
  }
  return exe;
}
