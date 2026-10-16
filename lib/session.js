/**
 * Interactive browser sessions, driven over the Chrome DevTools Protocol.
 *
 * Why this exists next to the fetch tool: `moli_fetch` is one shot -- it loads a
 * page and prints it. That covers reading. It cannot click a cookie banner, fill a
 * search box, scroll a lazy list, or wait for a client-side route change, which is
 * most of what "use the web" means for an agent.
 *
 * ## Two backends, chosen explicitly
 *
 * `moli serve` publishes CDP, WebDriver Classic and WebDriver BiDi on a loopback
 * port, and so does any Chromium browser with `--remote-debugging-port`. CDP is a
 * protocol, so the client below does not care which one answers -- only two things
 * differ, and both are isolated here:
 *
 * 1. **How the process is started.** `moli serve ...` versus `chrome --headless=new
 *    --remote-debugging-port=...`.
 * 2. **What element geometry means.** This is the reason a second backend exists at
 *    all. Moli's `getBoundingClientRect()` returns document-absolute coordinates
 *    that do not follow scrolling, and its hit test stops answering past the
 *    viewport height; measured against moli 1.1.16, an element at document y=1008
 *    reports y=1008 at scrollY 0, 400 and 800. A real Chromium is standards
 *    compliant: the same element reports 1008, 608, 208. Any automation written for
 *    one is wrong on the other, silently, so {@link ./actions.js} is told which
 *    frame it is working in and adapts.
 *
 * There is deliberately **no automatic fallback**. Switching engines because a
 * click failed would make the tool's timing and behaviour depend on which
 * operation happened to fail, and the caller could not tell which browser it was
 * talking to. `browser: moli | chromium` says what you get.
 *
 * ## Lifecycle
 *
 * A server is a long-lived child, unlike every other call in this plugin: `runOnce`
 * spawns, waits and reaps, while this process has to outlive a single tool call.
 * So the lifecycle is explicit -- started lazily on first use, held across calls,
 * stopped by `close` or when the plugin is disposed. Nothing blocks the DSH host:
 * the child is spawned asynchronously and every wait has a deadline.
 *
 * The sandbox blocks inherited pipes but not loopback TCP, so CDP works where a
 * piped child would not; child output goes to real files for the same reason.
 *
 * @module dsh-moli/lib/session
 */
import { spawn } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, openSync, rmSync } from 'node:fs';
import { createConnection } from 'node:net';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

/** CDP needs Node's built-in WebSocket, which arrived in 21. */
export const MIN_NODE_FOR_SESSION = '21.0.0';

/** Whether this Node can run a session at all. */
export function sessionSupported() {
  return typeof globalThis.WebSocket === 'function';
}

/** The message used when it cannot, so callers do not have to phrase it. */
export function sessionUnsupportedReason() {
  return `moli_session needs Node >= ${MIN_NODE_FOR_SESSION} for the built-in WebSocket; this is Node ${process.versions.node}. moli_fetch and moli_probe work on older versions.`;
}

/** Geometry conventions, per backend. */
export const GEOMETRY = {
  /** Standard: the rectangle is viewport-relative and follows the scroll. */
  viewport: 'viewport',
  /** Moli: the rectangle is document-absolute and the scroll does not move it. */
  absolute: 'absolute',
};

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

/** Whether something is listening on host:port. */
export function portListens(host, port, timeoutMs = 700) {
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

async function getJson(url, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) throw new Error(`HTTP ${String(response.status)} for ${url}`);
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

/** A writable directory for logs and browser profiles, outside the plugin tree. */
export function dataDir() {
  const base = process.env.LOCALAPPDATA ?? process.env.XDG_DATA_HOME ?? join(homedir(), '.local', 'share');
  const dir = join(base, 'dsh-moli');
  try { mkdirSync(dir, { recursive: true }); } catch { return tmpdir(); }
  return dir;
}

/**
 * Find a Chromium-family browser to drive.
 *
 * Node has no portable way to ask the OS for the default browser, so the known
 * install locations are probed. `browserPath` overrides it, which is also the way
 * to point at a build this list does not know about.
 */
export function findChromium(override) {
  const candidates = [];
  if (typeof override === 'string' && override !== '') candidates.push(override);
  if (process.platform === 'win32') {
    const pf = process.env['ProgramFiles'] ?? 'C:\\Program Files';
    const pf86 = process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)';
    const local = process.env.LOCALAPPDATA ?? '';
    candidates.push(
      join(pf, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      join(pf86, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      join(local, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      join(pf, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
      join(pf86, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
      join(pf, 'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe'),
    );
  } else if (process.platform === 'darwin') {
    candidates.push(
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
      '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
    );
  } else {
    candidates.push(
      '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium',
      '/usr/bin/chromium-browser', '/usr/bin/microsoft-edge', '/snap/bin/chromium',
      '/usr/bin/brave-browser',
    );
  }
  return candidates.find(p => p !== '' && existsSync(p));
}

// ---------------------------------------------------------------------------
// CDP client
// ---------------------------------------------------------------------------

/**
 * One WebSocket connection to a page target.
 *
 * `send` rejects on a protocol error and on a closed socket, so a caller can never
 * wait forever for a target that has gone away.
 */
class CdpConnection {
  constructor(ws, targetId) {
    this.ws = ws;
    this.targetId = targetId;
    this.nextId = 1;
    this.pending = new Map();
    this.listeners = new Set();
    this.closed = false;
    this.lastError = undefined;

    ws.addEventListener('message', event => {
      let message;
      try { message = JSON.parse(String(event.data)); } catch { return; }
      if (message.id !== undefined && this.pending.has(message.id)) {
        const entry = this.pending.get(message.id);
        this.pending.delete(message.id);
        if (message.error !== undefined) entry.reject(new Error(`${entry.method}: ${String(message.error.message ?? JSON.stringify(message.error))}`));
        else entry.resolve(message.result ?? {});
        return;
      }
      if (message.method !== undefined) {
        for (const listener of this.listeners) {
          try { listener(message); } catch { /* a listener must not break the socket */ }
        }
      }
    });

    const failAll = reason => {
      this.closed = true;
      this.lastError = reason;
      for (const [, entry] of this.pending) entry.reject(new Error(reason));
      this.pending.clear();
    };
    ws.addEventListener('close', () => failAll('the CDP connection closed'));
    ws.addEventListener('error', () => failAll('the CDP connection errored'));
  }

  onEvent(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Send one CDP command. */
  send(method, params = {}, timeoutMs = 30000) {
    if (this.closed) return Promise.reject(new Error(this.lastError ?? 'the CDP connection is closed'));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} timed out after ${String(timeoutMs)}ms`));
      }, timeoutMs);
      this.pending.set(id, {
        method,
        resolve: value => { clearTimeout(timer); resolve(value); },
        reject: error => { clearTimeout(timer); reject(error); },
      });
      try {
        this.ws.send(JSON.stringify({ id, method, params }));
      } catch (error) {
        this.pending.delete(id);
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  /**
   * Evaluate an expression in the page and return its value.
   *
   * A thrown expression comes back as `{ throws }` rather than a rejection: the
   * caller is a model, and "your selector matched nothing" is information, not a
   * transport failure.
   */
  async evaluate(expression, { awaitPromise = false, timeoutMs = 30000 } = {}) {
    const result = await this.send('Runtime.evaluate', {
      expression, returnByValue: true, awaitPromise, userGesture: true,
    }, timeoutMs);
    if (result.exceptionDetails !== undefined) {
      const detail = result.exceptionDetails;
      const text = detail.exception?.description ?? detail.text ?? 'the expression threw';
      return { throws: String(text).split('\n')[0] };
    }
    return { value: result.result?.value };
  }

  close() {
    this.closed = true;
    try { this.ws.close(); } catch { /* already gone */ }
  }
}

// ---------------------------------------------------------------------------
// server lifecycle
// ---------------------------------------------------------------------------

/**
 * Owns the browser process and the CDP connection to it.
 *
 * `ensure` is idempotent and reuses an external server when one is already
 * listening, so a browser the user started themselves can be driven without
 * fighting over the port -- and is left running when this plugin disposes.
 */
export class SessionManager {
  /**
   * @param options - engine path, backend choice, plugin config, and a logger.
   */
  constructor(options) {
    this.options = options;
    this.child = undefined;
    this.connection = undefined;
    /** Host and port of the browser this plugin manages. Never a per-call value. */
    this.host = options.host ?? '127.0.0.1';
    this.port = options.port ?? 9222;
    /**
     * A CDP URL to drive for the current call only. Kept apart from `host`/`port`
     * because it is transient: an earlier version overwrote `this.port` while
     * resolving it and never put it back, so one call against `...:9/` left the
     * session pointing at port 9 for the rest of the process.
     */
    this.overrideEndpoint = undefined;
    this.external = false;
    this.backend = undefined;
    this.geometry = GEOMETRY.absolute;
    this.pid = undefined;
    this.profileDir = undefined;
  }

  get started() {
    return this.child !== undefined && this.child.exitCode === null;
  }

  /** The host and port CDP is reached on right now. */
  get target() {
    if (this.overrideEndpoint === undefined) return { host: this.host, port: this.port };
    const parsed = new URL(this.overrideEndpoint);
    return {
      host: parsed.hostname,
      port: Number(parsed.port === '' ? (parsed.protocol === 'https:' ? 443 : 80) : parsed.port),
    };
  }

  /** Which browser this session talks to, for `status`. */
  describe() {
    const { host, port } = this.target;
    return {
      backend: this.backend,
      geometry: this.geometry,
      endpoint: this.overrideEndpoint ?? `http://${host}:${String(port)}`,
      external: this.external,
      ownedByThisPlugin: this.started,
      pid: this.pid,
      logPath: this.logPath,
    };
  }

  /**
   * Identify which geometry frame an endpoint's input APIs use.
   *
   * A name check cannot do this: moli answers `/json/version` with
   * `{"Browser":"Chrome/145.0.0.0"}`, so testing the product string classifies moli
   * as Chromium and picks the wrong frame -- the exact failure this mechanism
   * exists to prevent. It does, however, put its own name in the debugger URL
   * (`ws://127.0.0.1:9222/devtools/browser/moli-browser`), which no other browser
   * does, so that is the marker used.
   *
   * A behavioural probe was tried first and is not reliable: moli updates element
   * geometry lazily, so scrolling and re-measuring inside one evaluation shows the
   * rectangle moving, and only a later read reveals that it snapped back to
   * document-absolute. A hint that costs no round trip and cannot be mistimed is
   * better than a measurement that has to guess when to look.
   */
  #detectGeometry(version) {
    const product = String(version?.Browser ?? '');
    const socket = String(version?.webSocketDebuggerUrl ?? '');
    if (/moli|lexmount/iu.test(product) || /moli/iu.test(socket)) {
      return { backend: 'moli', geometry: GEOMETRY.absolute };
    }
    return { backend: 'chromium', geometry: GEOMETRY.viewport };
  }

  /**
   * Ensure a browser is running and return a live connection.
   *
   * @returns `{ connection, backend, geometry, external }`.
   */
  async ensure() {
    if (this.connection !== undefined && this.connection.closed === false) {
      return { connection: this.connection, backend: this.backend, geometry: this.geometry, external: this.external };
    }
    this.connection = undefined;
    const { host, port } = this.target;

    // An explicit endpoint wins over everything: the caller has a browser.
    if (this.overrideEndpoint !== undefined) {
      const version = await this.#probeVersion(host, port);
      if (version === undefined) throw new Error(`no CDP endpoint answers at ${this.overrideEndpoint}`);
      const connection = await this.#connect(version, host, port);
      this.external = true;
      Object.assign(this, this.#detectGeometry(version));
      this.connection = connection;
      return { connection, backend: this.backend, geometry: this.geometry, external: true };
    }

    // Something already listening on the port? Use it rather than refuse to bind.
    if (await portListens(host, port)) {
      const version = await this.#probeVersion(host, port);
      if (version !== undefined) {
        const connection = await this.#connect(version, host, port);
        this.external = true;
        // A foreign server is not identifiable by name -- see #detectGeometry.
        Object.assign(this, this.#detectGeometry(version));
        this.connection = connection;
        return { connection, backend: this.backend, geometry: this.geometry, external: true };
      }
      throw new Error(`port ${String(port)} is in use but does not answer as a CDP endpoint. Pass a different port, or stop whatever is listening there.`);
    }

    const wanted = this.options.browser ?? 'moli';
    if (wanted === 'chromium') await this.#spawnChromium();
    else if (wanted === 'moli') await this.#spawnMoli();
    else throw new Error(`unknown browser ${JSON.stringify(String(wanted))}; use "moli" or "chromium"`);

    const connection = await this.#connectAfterStart();
    this.connection = connection;
    return { connection, backend: this.backend, geometry: this.geometry, external: false };
  }

  /** Start `moli serve`, which already speaks CDP. */
  async #spawnMoli() {
    const exe = this.options.exe;
    if (exe === undefined) throw new Error('no moli engine was found, so a moli session cannot be started');
    const args = ['serve', '--host', this.host, '--port', String(this.port), '--layout'];
    if (this.options.insecureTls === true) args.push('--insecure-disable-tls-host-verification');
    if (this.options.proxy !== undefined && this.options.proxy !== '') args.push('--http-proxy', this.options.proxy);
    if (this.options.userAgent !== undefined && this.options.userAgent !== '') args.push('--user-agent', this.options.userAgent);
    if (this.options.profileDir !== undefined && this.options.profileDir !== '') args.push('--profile-dir', this.options.profileDir);
    if (this.options.resources === true) args.push('--resource');
    if (this.options.blockPrivateNetworks === true) args.push('--block-private-networks');
    for (const cidr of this.options.blockCidrs ?? []) args.push('--block-cidrs', cidr);
    this.backend = 'moli';
    this.geometry = GEOMETRY.absolute;
    await this.#spawn(exe, args, `dsh-moli-serve-${String(process.pid)}.log`);
  }

  /** Start a Chromium-family browser with remote debugging enabled. */
  async #spawnChromium() {
    const exe = findChromium(this.options.browserPath);
    if (exe === undefined) {
      throw new Error('no Chromium-family browser was found (Chrome, Edge or Brave). Set `browserPath` to the executable, or use browser: "moli".');
    }
    // A persistent profile, so logins and cookies survive `close`: an ephemeral
    // one is thrown away each time and makes every session start logged out.
    this.profileDir = this.options.profileDir !== undefined && this.options.profileDir !== ''
      ? this.options.profileDir
      : join(dataDir(), 'chromium-profile');
    try { mkdirSync(this.profileDir, { recursive: true }); } catch { /* the browser will report it */ }

    const args = [
      `--remote-debugging-port=${String(this.port)}`,
      '--remote-debugging-address=127.0.0.1',
      `--user-data-dir=${this.profileDir}`,
      // `--headless=new` is the modern headless that shares the real browser's
      // behaviour; older builds only understand bare `--headless`.
      '--headless=new',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-gpu',
      '--disable-background-networking',
      '--disable-sync',
      '--disable-extensions',
      '--disable-features=Translate,MediaRouter',
      '--hide-crash-restore-bubble',
      '--window-size=1280,900',
    ];
    if (this.options.userAgent !== undefined && this.options.userAgent !== '') args.push(`--user-agent=${this.options.userAgent}`);
    if (this.options.proxy !== undefined && this.options.proxy !== '') args.push(`--proxy-server=${this.options.proxy}`);
    if (this.options.insecureTls === true) args.push('--ignore-certificate-errors');
    args.push('about:blank');

    this.backend = 'chromium';
    this.geometry = GEOMETRY.viewport;
    await this.#spawn(exe, args, `dsh-moli-chromium-${String(process.pid)}.log`);
  }

  /** Spawn a browser child and wait for its debugging port. */
  async #spawn(exe, args, logName) {
    const logPath = join(dataDir(), logName);
    let outFd;
    try { outFd = openSync(logPath, 'w'); } catch { outFd = undefined; }
    const child = outFd === undefined
      ? spawn(exe, args, { stdio: 'ignore', windowsHide: true })
      : spawn(exe, args, { stdio: ['ignore', outFd, outFd], windowsHide: true });
    if (outFd !== undefined) closeSync(outFd);
    this.child = child;
    this.pid = child.pid;
    this.logPath = logPath;

    const timeout = this.options.startTimeoutMs ?? 25000;
    const deadline = Date.now() + timeout;
    for (;;) {
      if (child.exitCode !== null) {
        throw new Error(`${this.backend} exited with ${String(child.exitCode)} before listening; see ${logPath}`);
      }
      if (await portListens(this.host, this.port, 400)) return;
      if (Date.now() > deadline) {
        child.kill('SIGTERM');
        throw new Error(`${this.backend} did not listen on ${this.host}:${String(this.port)} within ${String(timeout)}ms; see ${logPath}`);
      }
      await sleep(150);
    }
  }

  /**
   * Wait for a usable page target after the port opens, then confirm the frame.
   *
   * The backend is already known here -- we spawned it -- so the frame it was
   * started with is authoritative and no probe is needed. Verifying it anyway cost
   * a round trip and could disagree with the process we are holding, so it does not.
   */
  async #connectAfterStart() {
    let lastError;
    for (let attempt = 0; attempt < 40; attempt++) {
      try {
        const version = await this.#probeVersion(this.host, this.port);
        if (version !== undefined) return await this.#connect(version, this.host, this.port);
      } catch (error) { lastError = error; }
      await sleep(200);
    }
    this.child?.kill('SIGTERM');
    throw new Error(`${String(this.backend)} is listening on port ${String(this.port)} but no page target was reachable: ${String(lastError?.message ?? 'unknown')}`);
  }

  async #probeVersion(host, port) {
    try {
      const version = await getJson(`http://${host}:${String(port)}/json/version`, 3000);
      return typeof version.Browser === 'string' ? version : undefined;
    } catch {
      return undefined;
    }
  }

  /** Open a WebSocket to the first page target and enable the domains we use. */
  async #connect(version, host, port) {
    if (!sessionSupported()) throw new Error(sessionUnsupportedReason());
    const targets = await getJson(`http://${host}:${String(port)}/json/list`, 5000);
    const page = Array.isArray(targets) ? targets.find(t => t.type === 'page') : undefined;
    if (page === undefined || typeof page.webSocketDebuggerUrl !== 'string') {
      throw new Error(`no page target on http://${host}:${String(port)}/json/list`);
    }
    const ws = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('the CDP WebSocket did not open in time')), 15000);
      ws.addEventListener('open', () => { clearTimeout(timer); resolve(); }, { once: true });
      ws.addEventListener('error', () => { clearTimeout(timer); reject(new Error('the CDP WebSocket failed to open')); }, { once: true });
    });
    const connection = new CdpConnection(ws, page.id);
    for (const domain of ['Page.enable', 'Runtime.enable', 'DOM.enable']) {
      await connection.send(domain, {}, 10000);
    }
    this.browserVersion = version?.Browser;
    return connection;
  }

  /**
   * Run something against a specific CDP endpoint, without latching onto it.
   *
   * A per-call endpoint has to be scoped to the call. Latching it permanently --
   * which an earlier version did by assigning `this.endpoint` -- meant a single
   * call that named a bad or dead endpoint poisoned every later call, and a call
   * that named a good one silently redirected the whole session. The previous
   * endpoint is restored afterwards, including when the call throws.
   *
   * This is also how a browser the user already has open, with their cookies and
   * logins, gets driven: start it with `--remote-debugging-port`, pass that URL,
   * and nothing is spawned or stopped on its behalf.
   */
  async withEndpoint(endpoint, work) {
    // Already attached to exactly this endpoint: reuse it rather than reconnect.
    if (this.overrideEndpoint === endpoint && this.connection !== undefined && this.connection.closed === false) {
      return work({ connection: this.connection, backend: this.backend, geometry: this.geometry, external: true });
    }
    // Save the managed browser's own state. Clearing it instead -- which an earlier
    // version did -- meant a `status` or `close` that named an endpoint discarded
    // the connection to the browser this plugin manages, and the following `close`
    // then stopped that browser on the caller's behalf.
    const saved = {
      connection: this.connection,
      backend: this.backend,
      geometry: this.geometry,
      external: this.external,
      browserVersion: this.browserVersion,
    };
    if (this.connection !== undefined && this.connection.closed === false) this.connection.close();
    this.connection = undefined;
    this.overrideEndpoint = endpoint;
    try {
      return await work(await this.ensure());
    } finally {
      // A connection opened for this call is not kept: the caller asked for one call
      // against that browser, not for the plugin to keep talking to it. The managed
      // host and port were never touched, so restoring the saved state is enough.
      // The saved connection may have been closed during the call -- `close` does
      // exactly that -- so it is only restored while it is still usable.
      this.connection = saved.connection !== undefined && saved.connection.closed === false
        ? saved.connection
        : undefined;
      this.backend = saved.backend;
      this.geometry = saved.geometry;
      this.external = saved.external;
      this.browserVersion = saved.browserVersion;
      this.overrideEndpoint = undefined;
    }
  }

  /**
   * Stop the browser this plugin started. A browser it merely attached to -- one the
   * caller named, or one already listening on the port -- is left running.
   *
   * When an override endpoint is active, only that connection is dropped: the
   * managed browser is not the subject of this call and must not be stopped by it.
   */
  async close() {
    const connection = this.connection;
    this.connection = undefined;
    if (connection !== undefined) connection.close();

    if (this.overrideEndpoint !== undefined) {
      return { stopped: false, external: true, scope: this.overrideEndpoint };
    }

    const child = this.child;
    this.child = undefined;
    const pid = this.pid;
    this.pid = undefined;
    const wasExternal = this.external;
    this.external = false;
    if (child === undefined || child.exitCode !== null) {
      return { stopped: false, external: wasExternal };
    }
    child.kill('SIGTERM');
    const deadline = Date.now() + 6000;
    while (child.exitCode === null && Date.now() < deadline) await sleep(120);
    if (child.exitCode === null) child.kill('SIGKILL');
    return { stopped: true, external: false, pid, backend: this.backend, logPath: this.logPath };
  }

  /** Remove a Chromium profile this plugin created. */
  forgetProfile() {
    if (this.backend !== 'chromium' || this.profileDir === undefined) return undefined;
    const dir = this.profileDir;
    this.profileDir = undefined;
    try { rmSync(dir, { recursive: true, force: true }); return dir; } catch { return undefined; }
  }

  /** Diagnostic view for the tool's `status` action. */
  async status() {
    const base = { running: this.started || this.external, ...this.describe(), browserVersion: this.browserVersion, logPath: this.logPath };
    const connection = this.connection;
    if (connection === undefined || connection.closed === true) return base;
    // Asking a browser that has gone away for its current page must not turn a
    // status report into an exception; report what is known and drop the socket.
    try {
      const url = await connection.evaluate('location.href');
      const title = await connection.evaluate('document.title');
      return { ...base, url: url.value, title: title.value };
    } catch {
      this.connection = undefined;
      return { ...base, running: this.started, pageUnavailable: true };
    }
  }
}
