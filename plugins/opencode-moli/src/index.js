/**
 * OpenCode adapter for the local Moli headless browser.
 *
 * Two registrations, both through the V2 plugin API:
 * - a websearch provider, so OpenCode's built-in `websearch` tool can search
 *   through the local browser instead of a paid search API;
 * - `moli_fetch` / `moli_capture` / `moli_probe`, for pages that need real
 *   rendering, a CSS selector, an evaluated expression, or a binary artifact.
 *
 * The build copies the shared browser core into ./lib. It is the same core the
 * DSH and Codex adapters use and imports only Node built-ins, so this file
 * contains no host-specific process plumbing: no DSH sandbox workarounds, no
 * MCP transport.
 */
import { Plugin } from '@opencode/plugin'
import { MANUAL_INSTALL, installMoli } from './lib/install.js'
import { findMoli, moliCandidates, probe, runFetch } from './lib/moli.js'
import { clampSearchLimit, parseSearchUrls, providerLabel, runSearch } from './lib/search.js'

const SERVER_VERSION = '__MOLI_VERSION__'

const DEFAULTS = {
  defaultTimeoutMs: 30000,
  searchAttemptTimeoutMs: 20000,
  maxChars: 200000,
  installTimeoutMs: 180000,
  searchLimit: 10,
  // Same default as the DSH plugin: behind a filtering proxy Schannel cannot
  // reach the revocation responder, so certificate checks fail on ordinary
  // sites. Set insecureTls: false to enforce them on a healthy network.
  insecureTls: true,
}

function positiveInteger(value, fallback) {
  return Number.isInteger(value) && value > 0 ? value : fallback
}

function envBoolean(value, fallback = false) {
  if (typeof value !== 'string' || value.trim() === '') return fallback
  return /^(1|true|yes|on)$/iu.test(value.trim())
}

function envString(name) {
  const value = process.env[name]
  return typeof value === 'string' ? value.trim() : ''
}

function searchUrlList(options) {
  const configured = Array.isArray(options.searchUrls)
    ? options.searchUrls
    : (envString('MOLI_SEARCH_URLS') || envString('MOLI_SEARCH_URL'));
  // The default order is the shared search core's, so this adapter cannot drift
  // from the Codex one on which provider is tried first.
  return parseSearchUrls(configured);
}

function readConfig(options) {
  const raw = options !== null && typeof options === 'object' ? options : {}
  const proxy = typeof raw.proxy === 'string' && raw.proxy.trim() !== ''
    ? raw.proxy.trim()
    : (envString('MOLI_PROXY')
      || envString('HTTPS_PROXY')
      || envString('HTTP_PROXY')
      || envString('ALL_PROXY'))
  return {
    exePath: typeof raw.exePath === 'string' && raw.exePath.trim() !== ''
      ? raw.exePath.trim()
      : envString('MOLI_BIN'),
    proxy,
    searchUrls: searchUrlList(raw),
    defaultTimeoutMs: positiveInteger(raw.defaultTimeoutMs, positiveInteger(Number(envString('MOLI_TIMEOUT_MS')), DEFAULTS.defaultTimeoutMs)),
    searchAttemptTimeoutMs: positiveInteger(raw.searchAttemptTimeoutMs, positiveInteger(Number(envString('MOLI_SEARCH_ATTEMPT_TIMEOUT_MS')), DEFAULTS.searchAttemptTimeoutMs)),
    maxChars: positiveInteger(raw.maxChars, positiveInteger(Number(envString('MOLI_MAX_CHARS')), DEFAULTS.maxChars)),
    installTimeoutMs: positiveInteger(raw.installTimeoutMs, positiveInteger(Number(envString('MOLI_INSTALL_TIMEOUT_MS')), DEFAULTS.installTimeoutMs)),
    searchLimit: positiveInteger(raw.searchLimit, DEFAULTS.searchLimit),
    insecureTls: typeof raw.insecureTls === 'boolean' ? raw.insecureTls : envBoolean(envString('MOLI_INSECURE_TLS'), DEFAULTS.insecureTls),
  }
}

/**
 * The input schemas are the same raw JSON Schema documents the DSH and Codex
 * adapters publish. OpenCode accepts a JSON Schema directly as a tool input.
 */
const FETCH_INPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['url'],
  properties: {
    url: { type: 'string', description: 'Absolute http:// or https:// URL to render.' },
    dump: {
      type: 'string',
      enum: ['html', 'markdown', 'json', 'semantic_tree', 'semantic_tree_text', 'screenshot', 'screenshot_full', 'pdf'],
      description: 'Output format. Omit for rendered HTML. `markdown` is the cheapest way to read a page. `json` carries status and final_url; screenshot/pdf need writeTo.',
    },
    writeTo: {
      type: 'string',
      description: 'Absolute path to save the output. Required for screenshot/pdf; optional for text dumps larger than maxChars.',
    },
    selector: {
      type: 'string',
      description: 'Return the text of the elements this CSS selector matches instead of the whole page. The cheap way to read one container out of a noisy listing page. Cannot be combined with dump or eval.',
    },
    eval: {
      type: 'string',
      description: 'JavaScript expression evaluated once the page is ready; its value is returned instead of the page. With dump, the expression value is discarded by the engine and only the resulting page is returned.',
    },
    scroll: {
      type: 'string',
      description: 'Scroll before capture: pixels as a string ("800", "-500" to go up), or "top" / "bottom". Use it for lazy lists and intersection observers.',
    },
    wait: {
      type: 'string',
      enum: ['domcontentloaded', 'load', 'networkidle', 'domstable', 'done'],
      description: 'Readiness stage to wait for. Defaults to `done`.',
    },
    waitSelector: { type: 'string', description: 'Wait until this CSS selector matches.' },
    waitScript: { type: 'string', description: 'Wait until this JavaScript expression is truthy.' },
    waitResponseUrl: { type: 'string', description: 'Wait for a response whose URL contains this substring.' },
    waitResponseJson: { type: 'string', description: 'Wait for a JSON response field matching PATH=VALUE.' },
    failOnHttpError: { type: 'boolean', description: 'Treat a final HTTP status of 400 or above as a failure while preserving the response body.' },
    delayMs: { type: 'integer', minimum: 0, description: 'Extra milliseconds to wait after readiness.' },
    timeoutMs: { type: 'integer', minimum: 1, description: 'Readiness deadline in milliseconds.' },
    maxChars: { type: 'integer', minimum: 1, description: 'Inline text truncation budget.' },
    headers: { type: 'array', items: { type: 'string' }, description: 'Extra request headers as "Name: value".' },
    userAgent: { type: 'string', description: 'Override the User-Agent.' },
    layout: { type: 'boolean', description: 'Force the layout renderer on. Implied by screenshot and pdf.' },
    scrollbars: { type: 'boolean', description: 'Show native scrollbars in rendered output.' },
    noJs: { type: 'boolean', description: 'Disable page-authored JavaScript.' },
    noCss: { type: 'boolean', description: 'Disable page-authored CSS.' },
    resources: { type: 'boolean', description: 'Also fetch images, fonts, audio, video, and text tracks.' },
    withFrames: { type: 'boolean', description: 'Include subframes in the output.' },
    insecureTls: { type: 'boolean', description: 'Skip TLS host verification for this call.' },
    proxy: { type: 'string', description: 'Forward proxy for this call. Loopback URLs always bypass it.' },
    profileDir: { type: 'string', description: 'Moli profile directory carrying imported cookies or storage.' },
    cookieFile: { type: 'string', description: 'Netscape/curl cookie-jar file to send.' },
  },
}

const CAPTURE_INPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['url', 'dump', 'writeTo'],
  properties: {
    url: { type: 'string', description: 'Absolute page URL.' },
    dump: { type: 'string', enum: ['screenshot', 'screenshot_full', 'pdf'], description: 'Binary artifact format.' },
    writeTo: { type: 'string', description: 'Absolute output path ending in .png or .pdf.' },
    wait: { type: 'string', enum: ['domcontentloaded', 'load', 'networkidle', 'domstable', 'done'] },
    waitSelector: { type: 'string' },
    scroll: { type: 'string' },
    delayMs: { type: 'integer', minimum: 0 },
    timeoutMs: { type: 'integer', minimum: 1 },
    headers: { type: 'array', items: { type: 'string' } },
    userAgent: { type: 'string' },
    scrollbars: { type: 'boolean' },
    resources: { type: 'boolean' },
    withFrames: { type: 'boolean' },
    insecureTls: { type: 'boolean' },
    proxy: { type: 'string' },
    profileDir: { type: 'string' },
    cookieFile: { type: 'string' },
  },
}

const PROBE_INPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    action: { type: 'string', enum: ['probe', 'install'], description: '`probe` (default) only inspects; `install` downloads and runs the official release installer.' },
    expectedSha256: { type: 'string', description: 'With action "install": abort unless the downloaded installer matches this SHA256.' },
  },
}

function missingEngine() {
  return {
    ok: false,
    error: 'moli was not found',
    hint: 'Call moli_probe with action "install", set MOLI_BIN, or install Moli from the official release.',
    manualInstall: MANUAL_INSTALL,
  }
}

function renderFetchValue(value) {
  if (value.ok !== true) {
    const status = typeof value.status === 'number' ? ` (HTTP ${String(value.status)})` : ''
    const lines = [`Moli fetch failed for ${String(value.url)}${status}: ${String(value.error ?? 'unknown error')}`]
    if (value.sandboxTlsBlock === true) lines.push('Cause: TLS client credentials were unavailable in this process (HTTPS only).')
    if (value.unreachable === true) lines.push('Cause: the host did not answer; a local forward proxy is the usual fix on this network.')
    else if (value.possiblyUnreachable === true) lines.push('Cause: the host did not answer in time; it may be blocked, or the page may simply be slow.')
    else if (value.conditionTimedOut === true) lines.push('Cause: the page loaded, but the wait condition never became true — this is not a network problem.')
    if (typeof value.hint === 'string' && value.hint !== '') lines.push(`Next: ${value.hint}`)
    if (value.httpError === true && value.kind === 'binary' && typeof value.path === 'string') {
      lines.push(`The error page was still written to ${value.path} (${String(value.bytes)} bytes).`)
    } else if (value.httpError === true && typeof value.content === 'string' && value.content !== '') {
      lines.push('', 'The server\'s response body:', '', value.content)
    } else if (typeof value.selector === 'string') {
      lines.push(`Selector: ${JSON.stringify(value.selector)}`
        + (typeof value.matched === 'number' ? ` (matched ${String(value.matched)})` : ''))
    }
    return lines.join('\n')
  }
  if (value.kind === 'binary') {
    return `${String(value.dump)} written to ${String(value.path)} (${String(value.bytes)} bytes). Read that file to inspect it.`
  }
  const parts = []
  if (value.evalDiscarded === true) {
    parts.push('Note: the `eval` expression was dropped because `dump` was given too — the engine discards the expression value in that combination. What follows is the page, not the expression.')
  }
  if (typeof value.selector === 'string' && typeof value.matched === 'number') {
    parts.push(`Selector ${JSON.stringify(value.selector)} matched ${String(value.matched)} element(s).`)
  }
  if (typeof value.note === 'string' && value.note !== '') parts.push(value.note)
  parts.push(String(value.content ?? ''))
  return parts.join('\n\n')
}

function renderProbeValue(value) {
  if (value.ok === true && typeof value.exe === 'string') {
    return `Installed ${String(value.version)} at ${String(value.exe)} (installer SHA256 ${String(value.installerSha256)}, ${String(value.installerBytes)} bytes). Run moli_probe again to verify HTTPS.`
  }
  if (value.ok === false) {
    const lines = [`Moli installation failed: ${String(value.error)}`]
    if (typeof value.installerSha256 === 'string') lines.push(`Installer SHA256: ${value.installerSha256}`)
    if (typeof value.note === 'string' && value.note !== '') lines.push(value.note)
    lines.push(`Manual install — PowerShell: ${MANUAL_INSTALL.powershell}`)
    lines.push(`Manual install — Linux/macOS: ${MANUAL_INSTALL.shell}`)
    return lines.join('\n')
  }
  if (value.installed !== true) {
    return [
      'moli was not found. Call moli_probe with action "install", or set the plugin option `exePath`.',
      `Manual install — PowerShell: ${MANUAL_INSTALL.powershell}`,
      `Manual install — Linux/macOS: ${MANUAL_INSTALL.shell}`,
    ].join('\n')
  }
  const lines = [
    `${String(value.version).startsWith('moli') ? String(value.version) : `moli ${String(value.version)}`} at ${String(value.exe)}`,
    value.httpsOk === true ? 'HTTPS fetch works from this process.' : `HTTPS fetch failed: ${String(value.detail)}`,
  ]
  // Which providers a search will try, and whether that path goes through a proxy,
  // is the part of the setup a failing search depends on -- so the probe states
  // both instead of leaving the caller to infer them from a timeout.
  if (Array.isArray(value.searchProviders) && value.searchProviders.length > 0) {
    lines.push(`Search providers, in order: ${value.searchProviders.join(' → ')}`)
  }
  lines.push(`Proxy: ${typeof value.proxy === 'string' && value.proxy !== '' ? value.proxy : 'not configured (direct)'}`)
  if (value.revocationBlock === true) {
    lines.push('The certificate-revocation responder is unreachable through this network; insecureTls already relaxes that check.')
  }
  return lines.join('\n')
}

export default Plugin.define({
  id: 'moli',
  async setup(ctx) {
    const config = readConfig(ctx.options)
    // Resolved once at setup and refreshed after an explicit install, so a
    // plugin load never blocks and no call re-runs discovery.
    let cachedExe = findMoli(config.exePath)
    const engine = () => cachedExe

    const policy = (args) => ({
      timeoutMs: positiveInteger(args.timeoutMs, config.defaultTimeoutMs),
      maxChars: positiveInteger(args.maxChars, config.maxChars),
      proxy: typeof args.proxy === 'string' && args.proxy !== '' ? args.proxy : config.proxy,
      insecureTls: typeof args.insecureTls === 'boolean' ? args.insecureTls : config.insecureTls,
    })

    const executeFetch = (args) => {
      const exe = engine()
      if (exe === undefined) return missingEngine()
      const settings = policy(args)
      return runFetch({
        exe,
        args: { ...args, timeoutMs: settings.timeoutMs },
        maxChars: settings.maxChars,
        proxy: settings.proxy,
        insecureTls: settings.insecureTls,
      })
    }

    const executeSearch = (query, args = {}, signal) => {
      const exe = engine()
      if (exe === undefined) return missingEngine()
      const settings = policy(args)
      // Provider order, the relevance guard, and redirect decoding come from the
      // shared search core, so this adapter answers exactly like the Codex one.
      return runSearch({
        exe,
        query,
        limit: clampSearchLimit(args.limit, config.searchLimit),
        urls: config.searchUrls,
        proxy: settings.proxy,
        insecureTls: settings.insecureTls,
        timeoutMs: settings.timeoutMs,
        attemptTimeoutMs: config.searchAttemptTimeoutMs,
        isAborted: () => signal?.aborted === true,
      })
    }

    await ctx.websearch.transform((editor) => {
      // Respect an explicit provider choice, including `false` (disabled). Only
      // supply the default when the user has not selected one.
      const selected = editor.default.get()
      editor.add({
        id: 'moli',
        name: 'Moli (local browser)',
        async execute(input, context) {
          if (context.signal.aborted) return []
          const value = executeSearch(input.query, {}, context.signal)
          if (value.ok !== true) {
            console.error(`[opencode-moli] websearch failed: ${String(value.error)}`)
            return []
          }
          return value.results.map(result => ({
            url: String(result.url),
            title: String(result.title ?? ''),
            content: String(result.snippet ?? ''),
            time: {},
          }))
        },
      })
      // A plugin-provided default is what makes the built-in websearch tool use
      // the local browser without a first-use provider prompt.
      if (selected === undefined) editor.default.set('moli')
    })

    await ctx.tool.transform((editor) => {
      editor.namespace({
        name: 'moli',
        description: 'Moli local headless browser: rendered pages, CSS selectors, evaluated values, screenshots, and PDFs.',
      })
      editor.add({
        name: 'fetch',
        description: 'Fetch a URL with the local Moli headless browser and return rendered Markdown, HTML, a semantic tree, a JSON envelope, a CSS-selector match, or a JavaScript expression result. Use it for pages that need real rendering; prefer the built-in webfetch for plain text. Screenshot and PDF dumps need writeTo.',
        input: FETCH_INPUT_SCHEMA,
        options: { namespace: 'moli', codemode: true },
        async execute(input) {
          return { content: renderFetchValue(executeFetch(input)) }
        },
      })
      editor.add({
        name: 'capture',
        description: 'Render a page with Moli and write a screenshot or PDF to an explicit absolute path.',
        input: CAPTURE_INPUT_SCHEMA,
        options: { namespace: 'moli', codemode: true },
        async execute(input) {
          return { content: renderFetchValue(executeFetch(input)) }
        },
      })
      editor.add({
        name: 'probe',
        description: 'Report the local Moli executable, version, and whether HTTPS fetching works, or install the official Moli release with action "install".',
        input: PROBE_INPUT_SCHEMA,
        options: { namespace: 'moli', codemode: true },
        async execute(input) {
          if (input.action === 'install') {
            const outcome = await installMoli({
              exePath: config.exePath,
              expectedSha256: input.expectedSha256,
              timeoutMs: config.installTimeoutMs,
              proxy: config.proxy,
              locate: findMoli,
              candidates: moliCandidates(config.exePath),
            })
            if (outcome.ok === true) cachedExe = outcome.exe
            return { content: renderProbeValue({ ...outcome, installed: outcome.ok === true }) }
          }
          const exe = engine()
          if (exe === undefined) {
            return {
              content: renderProbeValue({
                installed: false,
                searchProviders: config.searchUrls.map(providerLabel),
                proxy: config.proxy,
                detail: 'moli not found. Re-run with action "install" to download it.',
              }),
            }
          }
          // Probed through the configured proxy, so the reported HTTPS result
          // describes the path search and fetch actually take.
          const result = probe(exe, 'https://example.com', config.insecureTls, config.proxy)
          return {
            content: renderProbeValue({
              installed: true,
              exe: result.exe,
              version: result.version,
              httpsOk: result.httpsOk,
              detail: result.detail,
              revocationBlock: result.revocationBlock,
              searchProviders: config.searchUrls.map(providerLabel),
              proxy: config.proxy,
            }),
          }
        },
      })
    })

    console.error(`[opencode-moli] ${SERVER_VERSION}: registered websearch provider "moli" and moli_fetch / moli_capture / moli_probe (${cachedExe ?? 'moli missing'})`)
  },
})
