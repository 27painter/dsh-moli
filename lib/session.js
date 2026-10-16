/**
 * Interactive browser sessions, backed by `moli serve` and driven over CDP.
 *
 * Why this exists next to the fetch tool: `moli_fetch` is one shot -- it loads a
 * page and prints it. That covers reading. It cannot click a cookie banner, fill
 * a search box, scroll a lazy list, or wait for a client-side route change, which
 * is most of what "use the web" means for an agent.
 *
 * `moli serve` already exposes Chrome DevTools Protocol, WebDriver Classic and
 * WebDriver BiDi; this module talks CDP over the loopback WebSocket that the
 * server publishes at `/json/list`. No dependency is added: Node's built-in
 * `WebSocket` (21+) does the transport, which is why this feature needs a newer
 * Node than the rest of the plugin.
 *
 * Two design constraints come from the plugin's history and shape everything here:
 *
 * - **A server is a long-lived child, unlike every other call in this plugin.**
 *   `runOnce` spawns, waits and reaps. A serve process must outlive a single tool
 *   call, so its lifecycle is explicit: started lazily on first use, held across
 *   calls, and stopped by `close`. Nothing here may block the DSH host, so the
 *   child is spawned asynchronously and every wait is cancellable.
 * - **The sandbox blocks named pipes, not loopback TCP.** The plugin writes child
 *   stdout to real files for that reason. HTTP and WebSocket over 127.0.0.1 are
 *   fine -- verified under the restricted sandbox -- so CDP works where an
 *   inherited pipe would not.
 *
 * @module dsh-moli/lib/session
 */
import { spawn } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, openSync, statSync, writeFileSync } from 'node:fs';
import { createConnection } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

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

// ---------------------------------------------------------------------------
// small helpers
// ---------------------------------------------------------------------------

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

/** Whether something is listening on host:port, used before spawning a server. */
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

/** GET a JSON document from the local server, with a deadline. */
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

// ---------------------------------------------------------------------------
// CDP client
// ---------------------------------------------------------------------------

/**
 * A single WebSocket connection to one page target.
 *
 * `send` resolves with the CDP result or rejects with the protocol error, and
 * never rejects on a target that has gone away without a reply -- the socket
 * close path settles everything outstanding, so a caller cannot hang forever.
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

  /** Subscribe to protocol events; returns an unsubscribe function. */
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
   * A thrown expression is returned as `{ throws }` rather than rejected: the
   * caller is a model, and "your selector matched nothing" is information, not a
   * transport failure.
   */
  async evaluate(expression, { awaitPromise = false, timeoutMs = 30000 } = {}) {
    const result = await this.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise,
      userGesture: true,
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
 * Owns the `moli serve` child and the connection to it.
 *
 * One session per plugin instance. `ensure` is idempotent: it reuses a live
 * child, and if the port is already served by someone else's moli (the user's own
 * `moli serve`, another profile) it connects to that instead of failing to bind.
 */
export class SessionManager {
  /**
   * @param options - resolved engine path, plugin config, and a logger.
   */
  constructor(options) {
    this.options = options;
    this.child = undefined;
    this.connection = undefined;
    this.port = options.port ?? 9222;
    this.host = options.host ?? '127.0.0.1';
    this.external = false;
    this.pid = undefined;
  }

  /** The running child, or undefined when nothing was started by us. */
  get started() {
    return this.child !== undefined && this.child.exitCode === null;
  }

  /**
   * Start the server if needed and return a live CDP connection.
   *
   * @returns the connection, plus whether the server was already running.
   */
  async ensure() {
    if (this.connection !== undefined && this.connection.closed === false) {
      return { connection: this.connection, external: this.external };
    }
    this.connection = undefined;

    // Someone else may already serve this port: the user's own moli serve, or a
    // previous run that outlived us. Connecting to it is friendlier than refusing
    // to bind, and it is detectable: the CDP endpoint identifies the browser.
    if (await portListens(this.host, this.port)) {
      const version = await this.#probeVersion();
      if (version !== undefined) {
        const connection = await this.#connect();
        this.external = true;
        this.connection = connection;
        return { connection, external: true, version };
      }
      throw new Error(
        `port ${String(this.port)} is in use but does not answer as a CDP endpoint. `
        + 'Pass a different `port`, or stop whatever is listening there.');
    }

    if (!this.options.exe) throw new Error('no moli engine is available to start a session');

    const args = ['serve', '--host', this.host, '--port', String(this.port)];
    // Layout is what makes geometry, hit-testing and screenshots real; without it
    // the engine keeps compatibility geometry and clicks land in the wrong place.
    args.push('--layout');
    if (this.options.insecureTls === true) args.push('--insecure-disable-tls-host-verification');
    if (this.options.proxy !== undefined && this.options.proxy !== '') args.push('--http-proxy', this.options.proxy);
    if (this.options.userAgent !== undefined && this.options.userAgent !== '') args.push('--user-agent', this.options.userAgent);
    if (this.options.profileDir !== undefined && this.options.profileDir !== '') args.push('--profile-dir', this.options.profileDir);
    if (this.options.resources === true) args.push('--resource');
    if (this.options.blockPrivateNetworks === true) args.push('--block-private-networks');
    for (const cidr of this.options.blockCidrs ?? []) args.push('--block-cidrs', cidr);

    // Child output goes to real files: the sandbox blocks inherited pipes, the
    // same reason lib/moli.js redirects every other child.
    const logPath = join(tmpdir(), `dsh-moli-serve-${String(process.pid)}.log`);
    const outFd = openSync(logPath, 'w');
    const child = spawn(this.options.exe, args, { stdio: ['ignore', outFd, outFd], windowsHide: true });
    closeSync(outFd);
    this.child = child;
    this.pid = child.pid;
    this.logPath = logPath;

    const exited = new Promise(resolve => child.once('exit', code => resolve(code)));
    // Wait for the port, or for the child to die trying.
    const started = Date.now();
    const deadline = started + (this.options.startTimeoutMs ?? 20000);
    for (;;) {
      if (child.exitCode !== null) {
        throw new Error(`moli serve exited with ${String(child.exitCode)} before listening; see ${logPath}`);
      }
      if (await portListens(this.host, this.port, 400)) break;
      if (Date.now() > deadline) {
        child.kill('SIGTERM');
        throw new Error(`moli serve did not listen on ${this.host}:${String(this.port)} within ${String(this.options.startTimeoutMs ?? 20000)}ms; see ${logPath}`);
      }
      await sleep(150);
    }

    // The socket can open a moment before the target is published.
    let connection;
    let lastError;
    for (let attempt = 0; attempt < 20; attempt++) {
      try { connection = await this.#connect(); break; }
      catch (error) { lastError = error; await sleep(150); }
    }
    if (connection === undefined) {
      child.kill('SIGTERM');
      throw new Error(`moli serve is listening on port ${String(this.port)} but no page target was reachable: ${String(lastError?.message ?? 'unknown')}`);
    }
    void exited;
    this.external = false;
    this.connection = connection;
    return { connection, external: false };
  }

  /** Ask the CDP endpoint who it is; undefined when it is not a CDP endpoint. */
  async #probeVersion() {
    try {
      const version = await getJson(`http://${this.host}:${String(this.port)}/json/version`, 3000);
      return typeof version.Browser === 'string' ? version : undefined;
    } catch {
      return undefined;
    }
  }

  /** Open a WebSocket to the first page target and enable the domains we use. */
  async #connect() {
    if (!sessionSupported()) throw new Error(sessionUnsupportedReason());
    const targets = await getJson(`http://${this.host}:${String(this.port)}/json/list`, 5000);
    const page = Array.isArray(targets) ? targets.find(t => t.type === 'page' || t.type === undefined) : undefined;
    if (page === undefined || typeof page.webSocketDebuggerUrl !== 'string') {
      throw new Error(`no page target on http://${this.host}:${String(this.port)}/json/list`);
    }
    const ws = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('the CDP WebSocket did not open in time')), 10000);
      ws.addEventListener('open', () => { clearTimeout(timer); resolve(); }, { once: true });
      ws.addEventListener('error', () => { clearTimeout(timer); reject(new Error('the CDP WebSocket failed to open')); }, { once: true });
    });
    const connection = new CdpConnection(ws, page.id);
    for (const domain of ['Page.enable', 'Runtime.enable', 'DOM.enable']) {
      await connection.send(domain, {}, 10000);
    }
    return connection;
  }

  /** Stop the server if we started it. A reused external server is left alone. */
  async close() {
    const connection = this.connection;
    this.connection = undefined;
    if (connection !== undefined) connection.close();
    const child = this.child;
    this.child = undefined;
    this.pid = undefined;
    const wasExternal = this.external;
    this.external = false;
    if (child === undefined || child.exitCode !== null) {
      return { stopped: false, external: wasExternal };
    }
    child.kill('SIGTERM');
    const deadline = Date.now() + 5000;
    while (child.exitCode === null && Date.now() < deadline) await sleep(100);
    if (child.exitCode === null) child.kill('SIGKILL');
    return { stopped: true, external: false, logPath: this.logPath };
  }

  /** Diagnostic view of the session, for the tool's `status` action. */
  async status() {
    const running = this.started || this.external;
    const base = {
      running,
      ownedByThisPlugin: this.started,
      external: this.external,
      pid: this.pid,
      endpoint: `http://${this.host}:${String(this.port)}`,
      logPath: this.logPath,
    };
    if (!running) return base;
    const connection = this.connection;
    if (connection === undefined) return base;
    const url = await connection.evaluate('location.href');
    const title = await connection.evaluate('document.title');
    return { ...base, url: url.value, title: title.value };
  }
}
