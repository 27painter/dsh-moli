/** Host half of dsh-moli: expose the local `moli` headless browser as callable tools. */
import { MANUAL_INSTALL, installMoli, uninstallMoli } from './lib/install.js';
import { findMoli, moliCandidates, moliVersion, probe, runFetch } from './lib/moli.js';

export const name = 'dsh-moli';
export const inject = ['tools'];

/**
 * `@deepseek-ai/schemastery` powers the live Config schema and therefore the
 * settings namespace. A profile plugin is loaded from its real path on disk (a
 * `link:` dependency stays a symlink target), so a bare specifier must resolve
 * against the plugin's own `node_modules` chain — which does not exist when the
 * plugin is installed as a `link:`/junction (the README's first install route).
 * The import is therefore optional: without schemastery the settings form does
 * not appear and the plugin degrades to plain patch-layer configuration, while
 * `moli_fetch` / `moli_probe` keep registering — those are the plugin's reason
 * to exist, and losing them would be worse than losing the form.
 */
let z;
try {
  z = (await import('@deepseek-ai/schemastery')).default;
} catch {
  z = undefined;
}

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
 * Live Config schema. Declaring it (and exporting it) makes DSH register the
 * `dsh-moli` settings namespace, which the browser half's `plugins.bundle.config`
 * form edits. `.volatile()` marks the whole object live so the namespace appears
 * in the settings describe mirror and the form's writes are applied via the
 * ConfigEditor / volatile HMR path.
 *
 * `undefined` when `@deepseek-ai/schemastery` cannot be resolved (a `link:`
 * install) — then no settings namespace is registered and the engine lifecycle
 * is skipped, but the tools still register.
 */
export const Config = z
  ? z.object({
    defaultTimeoutMs: z.number().default(DEFAULTS.defaultTimeoutMs),
    maxChars: z.number().default(DEFAULTS.maxChars),
    insecureTls: z.boolean().default(DEFAULTS.insecureTls),
    proxy: z.string().default(''),
    exePath: z.string().default(''),
    // Engine lifecycle, driven by the settings form. The form writes an action
    // (`install` / `uninstall`) and the Host executes it asynchronously, then
    // reports the outcome back through `engineState` / `engineVersion` and resets
    // `engineAction` to `none`. `engineState` is `installed`, `missing`, or a
    // short error text.
    engineAction: z.union([z.const('none'), z.const('install'), z.const('uninstall')]).default('none'),
    engineState: z.string().default('unknown'),
    engineVersion: z.string().default(''),
  }).volatile()
  : undefined;

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
      description: 'Output format. Omit for rendered HTML. `markdown` is the cheapest way to read a page. `semantic_tree_text` is for locating things by structure (role, name, backend id), not for saving tokens: its size follows the page\'s node density and it is often larger than markdown — measured at 1.8x on a node-dense page — so prefer it only when you need the structure. `json` carries status and final_url; screenshot/pdf need writeTo.',
    },
    writeTo: {
      type: 'string',
      description: 'Absolute path to save the output. Required for screenshot/pdf; optional for text dumps larger than maxChars.',
    },
    selector: {
      type: 'string',
      description: 'Return the text of the elements this CSS selector matches instead of the whole page. This is the cheap way to read one container out of a noisy listing page: the cards on a feed measured 1,829 characters against 95,605 for the same page as markdown. All matches are joined with newlines and the result reports how many there were; matching nothing is an error, not empty content, because the engine cannot distinguish an empty selection from a page with no text. Not compatible with `dump` or `eval` — one of them could only be ignored.',
    },
    eval: {
      type: 'string',
      description: 'JavaScript expression evaluated once the page is ready; its value is returned as text or JSON instead of the page. Combining it with `dump` does NOT return both: the engine discards the expression value and dumps the resulting page state instead (its own documented semantics). Use `eval` alone to read a value, or `dump` alone to read the page.',
    },
    scroll: {
      type: 'string',
      description: 'Scroll the page before capturing it: a number of pixels down as a string ("800", "-500" to go up), or "top" / "bottom". A page that loads content on its first scroll event shows a placeholder without this and the loaded content with it, so use it for lazy lists, infinite scroll, and content revealed by an intersection observer. Runs as part of the engine\'s own pre-capture evaluation, so it happens before any `eval` expression reads the page.',
    },
    wait: {
      type: 'string',
      enum: ['domcontentloaded', 'load', 'networkidle', 'domstable', 'done'],
      description: 'Readiness stage to wait for. Defaults to `done`.',
    },
    waitSelector: { type: 'string', description: 'Wait until this CSS selector matches.' },
    waitScript: {
      type: 'string',
      description: 'Wait until this JavaScript expression is truthy; a function result is called as the predicate on each poll. More precise than a fixed delay when the page signals readiness in its own terms.',
    },
    waitResponseUrl: {
      type: 'string',
      description: 'Wait for a response whose original or final URL contains this substring. This is the reliable way to await an AJAX-built list: `wait: "networkidle"` plus a delay is a guess, whereas this waits for the request that actually carries the data.',
    },
    waitResponseJson: {
      type: 'string',
      description: 'Wait for a response whose JSON field equals a value, written as PATH=VALUE (for example "data.list.0.id=42"). The counterpart to waitResponseUrl when the condition is in the payload rather than the URL.',
    },
    failOnHttpError: {
      type: 'boolean',
      description: 'Treat a final main-document HTTP status of 400 or above as a failure. Without it an error page comes back as ordinary content and a 404 reads like a successful fetch; with it the result is ok:false and reports the status, while still carrying the rendered body so the error page can be read. Off by default, so existing calls keep their behaviour.',
    },
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
    evalDiscarded: { type: 'boolean' },
    selector: { type: 'string' },
    matched: { type: 'integer' },
    truncated: { type: 'boolean' },
    error: { type: 'string' },
    hint: { type: 'string' },
    status: { type: 'integer' },
    httpError: { type: 'boolean' },
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
     // An HTTP error keeps its body under `failOnHttpError`. Reporting the failure
    // without the body would throw away the error page, which is the part worth
    // reading -- and for a binary dump the body is the file that was written. A
    // selector failure is different: there is no server body to show, and the
    // message already says what did not match.
    if (value.httpError === true && value.kind === 'binary' && typeof value.path === 'string') {
      lines.push(`The error page was still written to ${value.path} (${String(value.bytes)} bytes).`);
    } else if (value.httpError === true && typeof value.content === 'string' && value.content !== '') {
      lines.push('', 'The server\'s response body:', '', value.content);
    } else if (typeof value.selector === 'string') {
      lines.push(`Selector: ${JSON.stringify(value.selector)}`
        + (typeof value.matched === 'number' ? ` (matched ${String(value.matched)})` : ''));
    }
    return [{ type: 'text', text: lines.join('\n') }];
  }
  if (value.kind === 'binary') {
    return [{
      type: 'text',
      text: `${String(value.dump)} written to ${String(value.path)} (${String(value.bytes)} bytes). Read that file to inspect it.`,
    }];
  }
  const parts = [];
  // A discarded `eval` value is the one case where the output looks like a clean
  // answer to a question that was never answered, so the warning goes first rather
  // than after the body, where a 900-character page would bury it.
  if (value.evalDiscarded === true) {
    parts.push('Note: the `eval` expression was dropped because `dump` was given too — the engine discards the expression value in that combination. What follows is the page, not the expression.');
  }
  // A selector answer is a list, so say how many elements produced it: "48 matched,
  // 34 had text" is the difference between a complete read and a partial one, and it
  // is the only signal the caller has that the selector was too broad or too narrow.
  if (typeof value.selector === 'string' && typeof value.matched === 'number') {
    parts.push(`Selector ${JSON.stringify(value.selector)} matched ${String(value.matched)} element(s).`);
  }
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
  // The Config schema is declared volatile, so DSH hands it as a live reference
  // whose `.get()` reads the current values; a deployment that mounts an older
  // loader without volatile wiring passes a plain object instead. Read either.
  const options = typeof config?.get === 'function' ? config.get() : (config ?? {});
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

  // ── engine lifecycle via the settings form ─────────────────────────────
  // The browser half's `plugins.bundle.config` form drives install/uninstall
  // through the `engineAction` field and reads the outcome from
  // `engineState`/`engineVersion`. State is written back only when it changes,
  // and a finished action always resets `engineAction` to `none`, so the
  // resulting `settings/document-updated` re-entry lands in the plain sync
  // branch instead of looping the action.
  //
  // Everything here depends on the settings namespace, which exists only when
  // schemastery resolved (see the `Config` export): without it there is no form
  // to drive the lifecycle, so the whole block is skipped and the plugin is
  // pure tool registration.
  if (Config) {
  const NS = 'dsh-moli';
  let engineBusy = false;
  const currentConfig = () => (typeof config.get === 'function' ? config.get() : (config ?? {}));
  // Write settings outside the current HMR transaction. `settings.update`
  // routes through dsh-hmr's runExclusive, which rejects when it is called
  // from inside an active transaction — the settings/document-updated event
  // handler runs in one, so a direct update throws
  // "HMR transactions cannot be nested" and the write-back is silently lost
  // (the form then stays on "working…" forever). setImmediate defers the
  // update until the event transaction has exited.
  const writeSettings = (settings, patch) =>
    new Promise((resolve, reject) => {
      setImmediate(() => {
        settings.update(NS, patch).then(resolve, reject);
      });
    });
  const syncEngineState = async (settings, current) => {
    const exe = findMoli(current.exePath);
    const state = exe === undefined ? 'missing' : 'installed';
    const version = exe === undefined ? '' : (moliVersion(exe) ?? '');
    if (current.engineState === state && current.engineVersion === version) return;
    try {
      await writeSettings(settings, { engineState: state, engineVersion: version });
    } catch (error) {
      console.error(`[dsh-moli] engine-state sync failed: ${String(error?.message ?? error)}`);
      ctx.logger?.warn?.('dsh-moli: engine-state sync failed', String(error?.message ?? error));
    }
  };
  const runEngineAction = async (settings, current, action) => {
    if (engineBusy) return;
    engineBusy = true;
    try {
      if (action === 'install') {
        const outcome = await installMoli({
          exePath: current.exePath,
          timeoutMs: 180000,
          proxy: current.proxy,
          locate: findMoli,
          candidates: moliCandidates(current.exePath),
        });
        cachedExe = outcome.ok === true ? (outcome.exe ?? cachedExe) : cachedExe;
        await writeSettings(settings, {
          engineAction: 'none',
          engineState: outcome.ok === true ? 'installed' : `install failed: ${String(outcome.error ?? 'unknown error').slice(0, 200)}`,
          engineVersion: outcome.ok === true ? String(outcome.version ?? '') : '',
        });
      } else if (action === 'uninstall') {
        const removed = uninstallMoli(current.exePath);
        cachedExe = undefined;
        await writeSettings(settings, {
          engineAction: 'none',
          engineState: removed === undefined ? 'uninstall failed: nothing to remove' : 'missing',
          engineVersion: '',
        });
      }
    } catch (error) {
      // console (not ctx.logger) so the failure reaches the service journal
      console.error(`[dsh-moli] engine action failed: ${String(error?.message ?? error)}`);
      ctx.logger?.error?.('dsh-moli: engine action failed', String(error?.message ?? error));
      try {
        await writeSettings(settings, {
          engineAction: 'none',
          engineState: `action failed: ${String(error?.message ?? error).slice(0, 200)}`,
        });
      } catch (error2) {
        console.error(`[dsh-moli] engine action failure report could not be written back: ${String(error2?.message ?? error2)}`);
        ctx.logger?.error?.('dsh-moli: engine action failure report could not be written back', String(error2?.message ?? error2));
      }
    } finally {
      engineBusy = false;
    }
  };
  // Dispatch an engineAction if one is pending, otherwise sync state. Shared by
  // the settings update handler and the boot-time initial sync, so an action
  // whose `settings/document-updated` event was lost (a crash between the
  // form's write and the handler) is still picked up on the next boot instead
  // of leaving the form stuck on "processing".
  // The event fires inside a dsh-hmr transaction. That transaction propagates
  // through AsyncLocalStorage into anything the handler spawns — including
  // setTimeout/setImmediate callbacks — so a deferred settings.update still
  // nests and is rejected ("HMR transactions cannot be nested"). dsh-hmr
  // itself escapes its own transaction with `executing.exit(...)` (watchConfig
  // does this); running the dispatch through the same exit clears the ALS
  // store so the write-back opens its own outermost transaction. The poller
  // below stays as a defensive fallback (exit missing, or an event lost
  // between the form's write and the handler).
  const dispatchOutsideTransaction = (settings) => {
    const hmr = ctx.get?.('hmr');
    const run = () => {
      const current = currentConfig();
      const action = current.engineAction;
      if (action === 'install' || action === 'uninstall') void runEngineAction(settings, current, action);
      else void syncEngineState(settings, current);
    };
    if (hmr && typeof hmr.executing?.exit === 'function') {
      hmr.executing.exit(run);
    } else {
      run();
    }
  };
  // Actions are driven by an independent poller as a fallback, and by the
  // transaction-escaped dispatch on the event path. A setInterval callback
  // runs in the timer phase, outside any transaction, so the action and its
  // write-back are safe there too.
  let pollTimer = null;
  let pendingCheck = false;
  const pollCheck = () => {
    const settings = ctx.get('settings');
    if (!settings) return;
    const current = currentConfig();
    const action = current.engineAction;
    if (action === 'install' || action === 'uninstall') {
      void runEngineAction(settings, current, action);
    } else {
      void syncEngineState(settings, current);
    }
  };
  ctx.on?.('settings/document-updated', (id) => {
    if (id !== NS) return;
    const settings = ctx.get('settings');
    if (!settings) return;
    pendingCheck = true;
    dispatchOutsideTransaction(settings);
  });
  pollTimer = setInterval(() => {
    if (pendingCheck) {
      pendingCheck = false;
      pollCheck();
    }
  }, 500);
  pollTimer.unref?.();
  // Initial state once settings is live. `ctx.get('settings')` may be null in a
  // boot-time effect (the service mounts later), so retry briefly; the poller
  // also picks up any pending engineAction written before the service settled.
  let syncAttempts = 0;
  const tryInitialSync = () => {
    const settings = ctx.get('settings');
    if (!settings) return false;
    pollCheck();
    return true;
  };
  if (!tryInitialSync()) {
    const timer = setInterval(() => {
      if (tryInitialSync() || ++syncAttempts >= 40) clearInterval(timer);
    }, 250);
    timer.unref?.();
  }
  }

  ctx.logger?.info?.(`dsh-moli: registered moli_fetch and moli_probe (${cachedExe ?? 'moli missing'})`);
}
