/** Host half of dsh-moli: expose the local `moli.exe` headless browser as callable tools. */
import { MANUAL_INSTALL, installMoli } from './lib/install.js';
import { findMoli, moliCandidates, probe, runFetch } from './lib/moli.js';

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

/** Parameter schema of `moli_fetch`, in the registry's DSL. */
const FETCH_PARAMETERS = {
  url: { type: 'string', required: true, description: 'Absolute http:// or https:// URL to fetch.' },
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
    description: 'JavaScript expression evaluated once the page is ready; its value is returned as text or JSON instead of the page.',
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
  profileDir: { type: 'string', description: 'Moli profile directory carrying imported cookies or storage.' },
  cookieFile: { type: 'string', description: 'Netscape/curl cookie-jar file to send.' },
};

/** Result schema of `moli_fetch`; only `ok` and `url` are always present. */
const FETCH_OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: true,
  properties: {
    ok: { type: 'boolean', required: true },
    url: { type: 'string', required: true },
    kind: { type: 'string', enum: ['text', 'binary'] },
    dump: { type: 'string' },
    content: { type: 'string' },
    path: { type: 'string' },
    chars: { type: 'integer' },
    bytes: { type: 'integer' },
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
  properties: {
    installed: { type: 'boolean', required: true },
    exe: { type: 'string' },
    version: { type: 'string' },
    httpsOk: { type: 'boolean' },
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
    const lines = ['moli.exe was not found. Call moli_probe with action "install", or set the plugin config field `exePath`.'];
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
    ctx.logger?.warn?.('dsh-moli: moli.exe not found; moli_probe can install it, or set config.exePath');
  }

  ctx.tools.register({
    name: 'moli_fetch',
    description: 'Fetch a URL with the local Moli headless browser: rendered HTML or Markdown, the semantic'
      + ' tree, a JSON envelope with status and final_url, a JavaScript expression result, a PNG screenshot, or a'
      + ' PDF. Use it for pages that need real rendering or JavaScript; prefer web_fetch for plain text. Screenshot'
      + ' and pdf dumps require writeTo. If moli.exe is missing, run moli_probe with action "install" first.',
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
          error: 'moli.exe was not found',
          sandboxTlsBlock: false,
          hint: 'Call moli_probe with action "install" to download it, or set the dsh-moli config field `exePath` to the absolute moli.exe path.',
          manualInstall: MANUAL_INSTALL,
        };
      }
      return runFetch({
        exe,
        args: { ...args, timeoutMs: args.timeoutMs ?? defaultTimeoutMs },
        maxChars,
        proxy,
        insecureTls,
      });
    },
  });

  ctx.tools.register({
    name: 'moli_probe',
    description: 'Report the local Moli install: version, executable path, and whether HTTPS fetching works from'
      + ' this process. With action "install" it downloads and runs the official Moli installer instead, then'
      + ' reports the executable and the SHA256 of the installer it ran. Use "install" only when moli_fetch'
      + ' reports that moli.exe is missing; it downloads and executes third-party code.',
    parameters: {
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
    output: { schema: PROBE_OUTPUT_SCHEMA, render: renderProbe },
    // Installation downloads and executes code, so it must never overlap itself.
    isConcurrencySafe: args => args.action !== 'install',
    async execute(args) {
      // An explicit install request is honoured even when an engine already
      // exists, so the action can also repair or upgrade an installation. Anything
      // else only inspects, because installing downloads and runs code.
      if (args.action === 'install') {
        const outcome = await installMoli({
          exePath: options.exePath,
          expectedSha256: args.expectedSha256,
          timeoutMs: options.installTimeoutMs ?? 180000,
          locate: findMoli,
          candidates: moliCandidates(options.exePath),
        });
        if (outcome.ok === true) {
          cachedExe = outcome.exe;
          ctx.logger?.info?.(`dsh-moli: installed ${String(outcome.version)} at ${String(outcome.exe)}`);
        }
        return outcome;
      }

      const exe = engine();
      if (exe === undefined) {
        return { installed: false, detail: 'moli.exe not found. Re-run with action "install" to download it.', manualInstall: MANUAL_INSTALL };
      }
      const result = probe(exe, 'https://example.com', insecureTls);
      return {
        installed: true,
        exe: result.exe,
        version: result.version,
        httpsOk: result.httpsOk,
        sandboxTlsBlock: result.sandboxTlsBlock,
        revocationBlock: result.revocationBlock,
        detail: result.detail,
      };
    },
  });

  ctx.logger?.info?.(`dsh-moli: registered moli_fetch and moli_probe (${cachedExe ?? 'moli.exe missing'})`);
}
