/** Host half of dsh-moli: expose the local `moli` headless browser as callable tools. */
import { performAction } from './lib/actions.js';
import { MANUAL_INSTALL, installMoli } from './lib/install.js';
import { findMoli, moliCandidates, probe, runFetch } from './lib/moli.js';
import { SessionManager, sessionSupported, sessionUnsupportedReason } from './lib/session.js';

export const name = 'dsh-moli';
export const inject = ['tools'];

/**
 * This plugin deliberately imports nothing but `node:` builtins and its own
 * files. A profile plugin is loaded from its real path on disk (a `link:`
 * dependency stays a symlink target), so a bare specifier such as
 * `@deepseek-ai/schemastery` would resolve against the plugin directory
 * instead of the profile's `node_modules` and fail to load. The registry
 * validates parameters and results itself, so `defineTool` and a Schema-based
 * config are not needed; configuration is read defensively from the patch layer.
 */

/** Deployment configuration defaults; override via the plugin's `config` entry. */
const DEFAULTS = {
  defaultTimeoutMs: 30000,
  maxChars: 200000,
  // Behind this machine's filtering proxy Schannel cannot reach the CRL/OCSP
  // responder, so GitHub and some APIs fail with
  // `CRYPT_E_REVOCATION_OFFLINE` ("the revocation server is offline").
  // moli's no-verify flag clears that; set insecureTls: false to enforce full
  // certificate checks on a network that can reach the responders.
  insecureTls: true,
};

/**
 * Parameter schema of `moli_fetch`.
 *
 * Both schema layers must be RAW JSON Schema here — object root, with `required`
 * as an object-level array — because this plugin registers plain definitions with
 * `ctx.tools.register` instead of going through `defineTool`.
 *
 * That choice is forced: `defineTool` lives in `@deepseek-ai/dsh-tools`, a bare
 * specifier, and a profile plugin is loaded from its real path on disk, so the
 * specifier does not resolve. `schemaOf` then projects `definition.parameters`
 * verbatim to the provider — it is NOT converted — so a parameter left in the
 * author DSL reaches the model without a root `type`, and the provider rejects the
 * request with `schema must be a JSON Schema of 'type: "object"', got 'type: null'`.
 *
 * The two entry points disagree, which is why one shape cannot serve both:
 * - a raw `output.schema` must use an object-level `required` array; a
 *   property-level `required: true` fails `assertSupportedJsonSchema` at registration
 * - `defineTool` is the opposite: its DSL rejects an object-level `required` and
 *   expects `required: true` on each property instead
 * Registering raw means the raw rules apply to parameters and outputs alike.
 */
const FETCH_PARAMETERS = {
  type: 'object',
  additionalProperties: false,
  required: ['url'],
  properties: {
    url: { type: 'string', description: 'Absolute http:// or https:// URL to fetch.' },
    dump: {
      type: 'string',
      enum: ['html', 'markdown', 'json', 'semantic_tree', 'semantic_tree_text', 'screenshot', 'screenshot_full', 'pdf'],
      description: 'Output format. Omit for rendered HTML. `markdown` and `semantic_tree_text` are the token-efficient choices for reading a page; `json` carries status and final_url; screenshot/pdf need writeTo.',
    },
    writeTo: {
      type: 'string',
      description: 'Absolute path to save the output. Required for screenshot/pdf; optional for text dumps larger than maxChars.',
    },
    eval: {
      type: 'string',
      description: 'JavaScript expression evaluated once the page is ready; its value is returned as text or JSON instead of the page. Combining it with `dump` does NOT return both: the engine discards the expression value and dumps the resulting page state instead (its own documented semantics). Use `eval` alone to read a value, or `dump` alone to read the page.',
    },
    wait: {
      type: 'string',
      enum: ['domcontentloaded', 'load', 'networkidle', 'domstable', 'done'],
      description: 'Readiness stage to wait for. Defaults to `done`.',
    },
    waitSelector: { type: 'string', description: 'Wait until this CSS selector matches.' },
    delayMs: { type: 'integer', description: 'Extra milliseconds to wait after readiness.' },
    timeoutMs: { type: 'integer', description: 'Total readiness deadline in milliseconds. Defaults to the plugin configuration.' },
    maxChars: { type: 'integer', description: 'Truncate inline text output to this many characters. Defaults to the plugin configuration.' },
    headers: { type: 'array', items: { type: 'string' }, description: 'Extra request headers, each as "Name: value".' },
    userAgent: { type: 'string', description: 'Override the User-Agent.' },
    layout: { type: 'boolean', description: 'Force the real layout renderer on. Implied by screenshot and pdf.' },
    scrollbars: { type: 'boolean', description: 'Show native scrollbars in rendered output.' },
    noJs: { type: 'boolean', description: 'Disable page-authored JavaScript.' },
    noCss: { type: 'boolean', description: 'Disable page-authored CSS.' },
    resources: { type: 'boolean', description: 'Also fetch images, fonts, audio, video, and text tracks.' },
    withFrames: { type: 'boolean', description: 'Include subframes in the output.' },
    insecureTls: { type: 'boolean', description: 'Skip TLS host verification. Use only for a known-broken local endpoint.' },
    proxy: {
      type: 'string',
      description: 'Forward proxy for this call, e.g. "http://127.0.0.1:7890". Overrides the plugin configuration for one call; loopback URLs always bypass it.',
    },
    profileDir: { type: 'string', description: 'Moli profile directory carrying imported cookies or storage.' },
    cookieFile: { type: 'string', description: 'Netscape/curl cookie-jar file to send.' },
  },
};

/**
 * `required` is an object-level array of property names in the registry's schema
 * subset for a RAW schema. A property-level `required: true` belongs to the
 * parameter DSL instead; here it makes the registry reject the tool.
 */

/** Result schema of `moli_fetch`; only `ok` and `url` are always present. */
const FETCH_OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: true,
  required: ['ok', 'url'],
  properties: {
    ok: { type: 'boolean' },
    url: { type: 'string' },
    kind: { type: 'string', enum: ['text', 'binary'] },
    dump: { type: 'string' },
    content: { type: 'string' },
    path: { type: 'string' },
    chars: { type: 'integer' },
    bytes: { type: 'integer' },
    empty: { type: 'boolean' },
    omitted: { type: 'integer' },
    evalFailed: { type: 'boolean' },
    truncated: { type: 'boolean' },
    error: { type: 'string' },
    hint: { type: 'string' },
    status: { type: 'integer' },
    sandboxTlsBlock: { type: 'boolean' },
    unreachable: { type: 'boolean' },
    possiblyUnreachable: { type: 'boolean' },
    note: { type: 'string' },
  },
};

/** Result schema of `moli_probe`; covers both the probe and install actions. */
const PROBE_OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: true,
  required: ['installed'],
  properties: {
    installed: { type: 'boolean' },
    exe: { type: 'string' },
    version: { type: 'string' },
    httpsOk: { type: 'boolean' },
    httpsOkScope: { type: 'string' },
    sandboxTlsBlock: { type: 'boolean' },
    revocationBlock: { type: 'boolean' },
    detail: { type: 'string' },
    ok: { type: 'boolean' },
    error: { type: 'string' },
    note: { type: 'string' },
    installerSha256: { type: 'string' },
    installerBytes: { type: 'integer' },
    expectedSha256: { type: 'string' },
    manualInstall: { type: 'object', additionalProperties: true },
    searchedPaths: { type: 'array', items: { type: 'string' } },
  },
};

/**
 * Render a `moli_fetch` value for the model.
 *
 * @param _args - the call arguments, unused.
 * @param value - the canonical result value.
 * @returns result content blocks.
 */
function renderFetch(_args, value) {
  if (value.ok !== true) {
    const status = typeof value.status === 'number' ? ` (HTTP ${String(value.status)})` : '';
    const lines = [`moli fetch failed for ${value.url}${status}: ${value.error ?? 'unknown error'}`];
    if (value.sandboxTlsBlock === true) lines.push('Cause: the DSH sandbox blocks Schannel client credentials (HTTPS only).');
    if (value.unreachable === true) lines.push('Cause: the host did not answer; a local forward proxy is the usual fix on this network.');
    else if (value.possiblyUnreachable === true) lines.push('Cause: the host did not answer in time; it may be blocked, or the page may simply be slow.');
    if (typeof value.hint === 'string' && value.hint !== '') lines.push(`Next: ${value.hint}`);
    return [{ type: 'text', text: lines.join('\n') }];
  }
  if (value.kind === 'binary') {
    return [{
      type: 'text',
      text: `${String(value.dump)} written to ${String(value.path)} (${String(value.bytes)} bytes). Read that file to inspect it.`,
    }];
  }
  const parts = [];
  if (typeof value.note === 'string' && value.note !== '') parts.push(value.note);
  parts.push(String(value.content ?? ''));
  return [{ type: 'text', text: parts.join('\n\n') }];
}

/**
 * Render a `moli_probe` value for the model.
 *
 * @param _args - the call arguments, unused.
 * @param value - the canonical diagnostic value.
 * @returns result content blocks.
 */
function renderProbe(_args, value) {
  // The install action reports `ok`/`error` instead of `installed`.
  if (value.ok === true && typeof value.exe === 'string') {
    return [{
      type: 'text',
      text: `Installed ${String(value.version)} at ${String(value.exe)} (installer SHA256 ${String(value.installerSha256)}, ${String(value.installerBytes)} bytes). Run moli_probe again to verify HTTPS.`,
    }];
  }
  if (value.ok === false) {
    const lines = [`Moli installation failed: ${String(value.error)}`];
    if (typeof value.installerSha256 === 'string') lines.push(`Installer SHA256: ${value.installerSha256}`);
    if (typeof value.note === 'string' && value.note !== '') lines.push(value.note);
    lines.push(`Manual install — PowerShell: ${MANUAL_INSTALL.powershell}`);
    lines.push(`Manual install — Linux/macOS: ${MANUAL_INSTALL.shell}`);
    return [{ type: 'text', text: lines.join('\n') }];
  }
  if (value.installed !== true) {
    const lines = ['moli was not found. Call moli_probe with action "install", or set the plugin config field `exePath`.'];
    lines.push(`Manual install — PowerShell: ${MANUAL_INSTALL.powershell}`);
    lines.push(`Manual install — Linux/macOS: ${MANUAL_INSTALL.shell}`);
    return [{ type: 'text', text: lines.join('\n') }];
  }
  const lines = [
    `${String(value.version).startsWith('moli') ? String(value.version) : `moli ${String(value.version)}`} at ${String(value.exe)}`,
    value.httpsOk === true
      ? 'HTTPS fetch works from this process.'
      : `HTTPS fetch failed: ${String(value.detail)}`,
  ];
  if (value.sandboxTlsBlock === true) {
    lines.push('This is the DSH sandbox Schannel restriction; retry the failing call with sandbox_permissions "danger-full-access".');
  }
  if (value.revocationBlock === true) {
    lines.push('The certificate-revocation responder is unreachable through this network, so the plugin\'s insecureTls default matters: calls already pass the no-verify flag unless a call sets insecureTls: false.');
  }
  return [{ type: 'text', text: lines.join('\n') }];
}

/** Actions `moli_session` accepts. */
const SESSION_ACTIONS = ['start', 'open', 'snapshot', 'click', 'type', 'press', 'scroll', 'waitFor', 'eval', 'screenshot', 'status', 'close'];

/**
 * Parameters of `moli_session`.
 *
 * Raw JSON Schema with a root `type: "object"`, like the other tools: `schemaOf`
 * projects this straight to the provider, so the author DSL would arrive as
 * `type: null` and be rejected.
 */
const SESSION_PARAMETERS = {
  type: 'object',
  additionalProperties: false,
  required: ['action'],
  properties: {
    action: {
      type: 'string',
      enum: SESSION_ACTIONS,
      description: 'start: ensure the browser is running. open: navigate. snapshot: read the rendered page. '
        + 'click/type/press/scroll: interact. waitFor: wait for a selector to appear or disappear. '
        + 'eval: run JavaScript in the page. screenshot: write a PNG. status: report the session. close: stop the browser.',
    },
    url: { type: 'string', description: 'open: absolute http:// or https:// URL to navigate to.' },
    selector: { type: 'string', description: 'CSS selector for click, type, scroll and waitFor.' },
    text: { type: 'string', description: 'type: the text to enter.' },
    submit: { type: 'boolean', description: 'type: press Enter after entering the text.' },
    clear: { type: 'boolean', description: 'type: empty the field before entering text.' },
    key: { type: 'string', description: 'press: key name, e.g. Enter, Tab, Escape, ArrowDown.' },
    dy: { type: 'number', description: 'scroll: pixels to move down (negative moves up). Defaults to 800.' },
    block: { type: 'string', enum: ['start', 'center', 'end', 'nearest'], description: 'scroll: where to align the element. Defaults to center.' },
    state: { type: 'string', enum: ['attached', 'detached'], description: 'waitFor: wait for the selector to appear (attached) or vanish (detached).' },
    expression: { type: 'string', description: 'eval: a JavaScript expression; promises are awaited and the value is returned.' },
    writeTo: { type: 'string', description: 'screenshot: absolute path for the PNG. Required, since images are not returned inline.' },
    format: { type: 'string', enum: ['png', 'jpeg'], description: 'screenshot: image format. Defaults to png.' },
    includeHtml: { type: 'boolean', description: 'snapshot: also return the rendered HTML.' },
    maxChars: { type: 'integer', description: 'snapshot: truncate the text to this many characters.' },
    timeoutMs: { type: 'integer', description: 'Deadline for this action. Defaults to the plugin configuration.' },
    port: { type: 'integer', description: 'start: CDP port. Defaults to the plugin configuration (9222).' },
  },
};

const SESSION_OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: true,
  required: ['ok'],
  properties: {
    ok: { type: 'boolean' },
    action: { type: 'string' },
    error: { type: 'string' },
    hint: { type: 'string' },
    url: { type: 'string' },
    title: { type: 'string' },
    text: { type: 'string' },
    chars: { type: 'integer' },
    truncated: { type: 'boolean' },
    links: { type: 'array', items: { type: 'object', additionalProperties: true } },
    fields: { type: 'array', items: { type: 'object', additionalProperties: true } },
    html: { type: 'string' },
    selector: { type: 'string' },
    clicked: { type: 'object', additionalProperties: true },
    navigated: { type: 'boolean' },
    submitted: { type: 'boolean' },
    value: {},
    serialized: { type: 'string' },
    key: { type: 'string' },
    y: { type: 'number' },
    height: { type: 'number' },
    viewport: { type: 'number' },
    state: { type: 'string' },
    waitedMs: { type: 'integer' },
    path: { type: 'string' },
    bytes: { type: 'integer' },
    format: { type: 'string' },
    running: { type: 'boolean' },
    ownedByThisPlugin: { type: 'boolean' },
    external: { type: 'boolean' },
    pid: { type: 'integer' },
    endpoint: { type: 'string' },
    logPath: { type: 'string' },
    settled: { type: 'boolean' },
    settledMs: { type: 'integer' },
    stopped: { type: 'boolean' },
  },
};

/**
 * Render a `moli_session` value for the model.
 *
 * A snapshot is the one result worth formatting rather than dumping as JSON: the
 * link and field tables are what the next action usually depends on.
 *
 * @param _args - the call arguments, unused.
 * @param value - the canonical result value.
 * @returns result content blocks.
 */
function renderSession(_args, value) {
  if (value.ok !== true) {
    const lines = [`moli_session failed${typeof value.action === 'string' ? ` (${value.action})` : ''}: ${value.error ?? 'unknown error'}`];
    if (typeof value.hint === 'string' && value.hint !== '') lines.push(value.hint);
    if (typeof value.bytes === 'number') lines.push(`(the image was ${String(value.bytes)} bytes but could not be written)`);
    return [{ type: 'text', text: lines.join('\n') }];
  }
  if (value.action === 'snapshot') {
    const lines = [`${String(value.title)} — ${String(value.url)}`, ''];
    lines.push(String(value.text ?? ''));
    if (Array.isArray(value.links) && value.links.length > 0) {
      lines.push('', `Links (${String(value.links.length)}):`);
      for (const link of value.links.slice(0, 25)) lines.push(`  ${String(link.text)} -> ${String(link.href)}`);
    }
    if (Array.isArray(value.fields) && value.fields.length > 0) {
      lines.push('', `Fields (${String(value.fields.length)}):`);
      for (const field of value.fields.slice(0, 25)) lines.push(`  <${String(field.tag)}${field.type === '' ? '' : ` type=${String(field.type)}`}${field.name === '' ? '' : ` name=${String(field.name)}`}${field.id === '' ? '' : ` id=${String(field.id)}`}>`);
    }
    return [{ type: 'text', text: lines.join('\n') }];
  }
  if (value.action === 'status') {
    return [{
      type: 'text',
      text: value.running === true
        ? `Session running at ${String(value.endpoint)}${value.external === true ? ' (started outside this plugin, so close will not stop it)' : ''}${value.url === undefined ? '' : `\nCurrent page: ${String(value.title)} — ${String(value.url)}`}`
        : 'No session is running. Call moli_session with action "start" or "open" to launch one.',
    }];
  }
  if (value.action === 'click') {
    return [{
      type: 'text',
      text: `Clicked ${String(value.clicked?.tag ?? 'element')}${value.clicked?.text === undefined || value.clicked.text === '' ? '' : ` (“${String(value.clicked.text)}”)`}`
        + `${value.navigated === true ? `, which navigated to ${String(value.url)}` : '; the page did not navigate'}`,
    }];
  }
  if (value.action === 'type') {
    return [{ type: 'text', text: `Entered text${value.submitted === true ? ' and pressed Enter' : ''}; the field now reads ${JSON.stringify(String(value.value ?? ''))}` }];
  }
  if (value.action === 'screenshot') {
    return [{ type: 'text', text: `Screenshot written to ${String(value.path)} (${String(value.bytes)} bytes). Read that file to see it.` }];
  }
  if (value.action === 'eval') {
    return [{ type: 'text', text: String(value.serialized ?? '') }];
  }
  if (value.action === 'close') {
    return [{ type: 'text', text: value.stopped === true ? 'Session stopped.' : 'Nothing to stop: no session was running that this plugin started.' }];
  }
  return [{ type: 'text', text: JSON.stringify(value) }];
}

/**
 * Register the Moli tools.
 *
 * Registration stays synchronous so a plugin load never delays Host startup; the
 * engine's presence is resolved once here and reused by every call.
 *
 * @param ctx - registrant context carrying the tool registry.
 * @param config - deployment configuration for paths, timeout, and output size.
 */
export function apply(ctx, config) {
  const options = config ?? {};
  // Mutable: a successful install resolves a path this process can use at once,
  // without waiting for a restart to re-run discovery.
  let cachedExe = findMoli(options.exePath);
  const engine = () => cachedExe;
  const defaultTimeoutMs = options.defaultTimeoutMs ?? DEFAULTS.defaultTimeoutMs;
  const maxChars = options.maxChars ?? DEFAULTS.maxChars;
  const proxy = options.proxy ?? '';
  const insecureTls = options.insecureTls ?? DEFAULTS.insecureTls;

  if (cachedExe === undefined) {
    ctx.logger?.warn?.('dsh-moli: moli not found; moli_probe can install it, or set config.exePath');
  }

  ctx.tools.register({
    name: 'moli_fetch',
    description: 'Fetch a URL with the local Moli headless browser: rendered HTML or Markdown, the semantic'
      + ' tree, a JSON envelope with status and final_url, a JavaScript expression result, a PNG screenshot, or a'
      + ' PDF. Use it for pages that need real rendering or JavaScript; prefer web_fetch for plain text. Screenshot'
      + ' and pdf dumps require writeTo. If moli is missing, run moli_probe with action "install" first.',
    parameters: FETCH_PARAMETERS,
    output: { schema: FETCH_OUTPUT_SCHEMA, render: renderFetch },
    isConcurrencySafe: args => args.writeTo === undefined || args.writeTo === '',
    async execute(args, exec) {
      if (exec.signal?.aborted === true) throw new Error('moli_fetch aborted before start');
      const exe = engine();
      if (exe === undefined) {
        return {
          ok: false,
          url: args.url,
          error: 'moli was not found',
          sandboxTlsBlock: false,
          hint: 'Call moli_probe with action "install" to download it, or set the dsh-moli config field `exePath` to the absolute moli path.',
          manualInstall: MANUAL_INSTALL,
        };
      }
      // A per-call proxy wins over the plugin configuration, so one host behind a
      // different proxy does not require a reconfiguration.
      return runFetch({
        exe,
        args: { ...args, timeoutMs: args.timeoutMs ?? defaultTimeoutMs },
        maxChars,
        proxy: typeof args.proxy === 'string' && args.proxy !== '' ? args.proxy : proxy,
        insecureTls,
      });
    },
  });

  ctx.tools.register({
    name: 'moli_probe',
    description: 'Report the local Moli install: version, executable path, and whether HTTPS fetching works from'
      + ' this process. With action "install" it downloads and runs the official Moli installer instead, then'
      + ' reports the executable and the SHA256 of the installer it ran. Use "install" only when moli_fetch'
      + ' reports that moli is missing; it downloads and executes third-party code.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      // No required entries: every parameter is optional, and each execution path
      // validates what it actually needs.
      properties: {
        action: {
          type: 'string',
          enum: ['probe', 'install'],
          description: '`probe` (default) only inspects; `install` downloads and runs the official release installer.',
        },
        expectedSha256: {
          type: 'string',
          description: 'With action "install": abort unless the downloaded installer matches this SHA256.',
        },
      },
    },
    output: { schema: PROBE_OUTPUT_SCHEMA, render: renderProbe },
    // Installation downloads and executes code, so it must never overlap itself.
    isConcurrencySafe: args => args.action !== 'install',
    async execute(args, exec) {
      // An explicit install request is honoured even when an engine already
      // exists, so the action can also repair or upgrade an installation. Anything
      // else only inspects, because installing downloads and runs code.
      if (args.action === 'install') {
        const outcome = await installMoli({
          exePath: options.exePath,
          expectedSha256: args.expectedSha256,
          timeoutMs: options.installTimeoutMs ?? 180000,
          proxy: options.proxy,
          locate: findMoli,
          candidates: moliCandidates(options.exePath),
          signal: exec?.signal,
        });
        if (outcome.ok === true) {
          cachedExe = outcome.exe;
          ctx.logger?.info?.(`dsh-moli: installed ${String(outcome.version)} at ${String(outcome.exe)}`);
        }
        // The output schema declares `installed` as required, but installMoli's
        // outcome carries `ok` instead. Surface both so the registry validator
        // accepts the result and renderProbe still sees the shape it expects.
        return { ...outcome, installed: outcome.ok === true };
      }

      const exe = engine();
      if (exe === undefined) {
        return { installed: false, detail: 'moli not found. Re-run with action "install" to download it.', manualInstall: MANUAL_INSTALL };
      }
      const result = probe(exe, 'https://example.com', insecureTls);
      return {
        installed: true,
        exe: result.exe,
        version: result.version,
        httpsOk: result.httpsOk,
        // Says which process the HTTPS result describes. Under the file sandbox a
        // restricted shell cannot reach the network while this path can, so the
        // caller should not read httpsOk as "this machine has internet".
        httpsOkScope: result.httpsOkScope,
        sandboxTlsBlock: result.sandboxTlsBlock,
        revocationBlock: result.revocationBlock,
        detail: result.detail,
      };
    },
  });

  // ---------------------------------------------------------------------------
  // moli_session: an interactive browser, for the work a one-shot fetch cannot do
  // ---------------------------------------------------------------------------
  //
  // This is the plugin's only stateful tool. `moli serve` is a long-lived child
  // that has to outlive a single call, so one manager is created per plugin
  // instance and its lifecycle is explicit (`start` implicitly, `close` by hand).
  // Registration stays synchronous: the server is spawned on first use, never at
  // load time, so a plugin load cannot delay Host startup or open a port.
  const session = new SessionManager({
    get exe() { return cachedExe; },
    port: options.sessionPort ?? 9222,
    host: '127.0.0.1',
    insecureTls,
    proxy: options.proxy,
    userAgent: options.sessionUserAgent,
    profileDir: options.profileDir,
    resources: options.sessionResources === true,
    // Off, matching the engine's own default: `moli fetch <private-ip>` can reach
    // a private address, so the plugin does not silently narrow what a user's
    // installed engine already does. Set it to true, or pass blockCidrs, to have
    // the engine refuse private addresses for directly connected targets.
    blockPrivateNetworks: options.blockPrivateNetworks === true,
    blockCidrs: Array.isArray(options.blockCidrs) ? options.blockCidrs : [],
    startTimeoutMs: options.sessionStartTimeoutMs ?? 20000,
  });

  ctx.tools.register({
    name: 'moli_session',
    description: 'Drive an interactive browser through a persistent session, for what a one-shot fetch cannot'
      + ' do: click through consent walls, fill and submit a search box, scroll a lazy list, wait for a'
      + ' client-side route change, or run a script in the page. Keeps one browser alive across calls, so'
      + ' state (cookies, navigation, form input) persists until you stop it with action "close".'
      + ' Start with "open"; read the page with "snapshot"; interact with "click", "type", "press" and'
      + ' "scroll"; use "eval" as the escape hatch. Elements are addressed by CSS selector, never by pixel'
      + ' coordinates.',
    parameters: SESSION_PARAMETERS,
    output: { schema: SESSION_OUTPUT_SCHEMA, render: renderSession },
    // One browser, one page: overlapping actions would interleave input events and
    // navigate the page out from under each other.
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      // `status` and `close` are meaningful with nothing running, so they are
      // answered before the engine is required.
      if (args.action === 'close') {
        const outcome = await session.close();
        return { ok: true, action: 'close', ...outcome };
      }
      if (args.action === 'status') {
        const state = await session.status();
        return { ok: true, action: 'status', ...state };
      }
      if (args.action === 'start') {
        if (!sessionSupported()) return { ok: false, action: 'start', error: sessionUnsupportedReason() };
        const { external } = await session.ensure();
        const state = await session.status();
        return { ok: true, action: 'start', started: true, external, ...state };
      }

      if (engine() === undefined) {
        return {
          ok: false,
          action: String(args.action),
          error: 'moli was not found, so a session cannot be started',
          hint: 'Call moli_probe with action "install", or set the plugin config field `exePath`.',
        };
      }
      if (!sessionSupported()) return { ok: false, action: String(args.action), error: sessionUnsupportedReason() };

      if (exec?.signal?.aborted === true) return { ok: false, action: String(args.action), error: 'the call was aborted before it started' };

      try {
        const { connection } = await session.ensure();
        const result = await performAction(connection, args, { maxChars });
        // A closed socket means the browser went away under us; drop it so the
        // next call starts a fresh one instead of failing forever.
        if (connection.closed === true) void session.close();
        return result;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const hint = /timed out/u.test(message)
          ? 'The action exceeded its deadline. Raise timeoutMs, or check `waitFor` for a selector that never appears.'
          : /ECONNREFUSED|closed|WebSocket/u.test(message)
            ? 'The browser connection was lost. Call moli_session with action "status", then "start" to relaunch it.'
            : undefined;
        return { ok: false, action: String(args.action), error: message, ...(hint === undefined ? {} : { hint }) };
      }
    },
  });

  ctx.logger?.info?.(`dsh-moli: registered moli_fetch, moli_probe and moli_session (${cachedExe ?? 'moli missing'})`);
}
