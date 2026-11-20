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

const SERVER_VERSION = '__MOLI_VERSION__'
const DEFAULT_SEARCH_URLS = [
  'https://www.bing.com/search?q={query}',
  'https://html.duckduckgo.com/html/?q={query}',
  'https://search.brave.com/search?q={query}',
]

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
    ? options.searchUrls.filter(url => typeof url === 'string' && url.trim() !== '').map(url => url.trim())
    : []
  if (configured.length > 0) return configured
  const env = envString('MOLI_SEARCH_URLS') || envString('MOLI_SEARCH_URL')
  if (env === '') return DEFAULT_SEARCH_URLS
  const urls = env.split('|').map(url => url.trim()).filter(url => url !== '')
  return urls.length > 0 ? urls : DEFAULT_SEARCH_URLS
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

/** Read a value from a URL's search result page. Kept in sync with the Codex adapter. */
function searchScript(limit) {
  return `(() => {
    const decodeResultUrl = href => {
      try {
        const parsed = new URL(href, location.href);
        const bingTarget = parsed.searchParams.get('u');
        if (bingTarget !== null) {
          const base64 = (bingTarget.startsWith('a1') ? bingTarget.slice(2) : bingTarget)
            .replace(/-/g, '+').replace(/_/g, '/');
          const padded = base64 + '='.repeat((4 - base64.length % 4) % 4);
          const decoded = atob(padded);
          if (/^https?:\\/\\//i.test(decoded)) return decoded;
        }
        return parsed.href;
      } catch {
        return href;
      }
    };
    const text = node => {
      const inner = (node?.innerText ?? '').trim();
      return inner !== '' ? inner : (node?.textContent ?? '').trim();
    };
    const clean = value => value
      .replace(/https?:\\/\\/\\S+/giu, '')
      .replace(/\\s+/gu, ' ')
      .replace(/\\s*Read more\\s*$/iu, '')
      .trim();
    const noResults = /There are no results|did not match any documents|No results found|No results for/iu.test(document.body.innerText);
    if (noResults) return JSON.stringify([]);
    const selectors = ['li.b_algo', 'div.snippet[data-type="web"]', 'div.snippet', 'div.result', 'div.web-result', '[data-testid="result"]'];
    // Brave wraps results in <article>. Bing also uses <article> for unrelated
    // top-story cards when a query has no results, so scope that selector to the
    // engine that means it instead of returning news as search hits.
    if (/search\\.brave\\.com$/iu.test(location.hostname)) selectors.push('article');
    const containers = [];
    const seenNodes = new Set();
    for (const selector of selectors) {
      for (const node of document.querySelectorAll(selector)) {
        if (!seenNodes.has(node)) {
          seenNodes.add(node);
          containers.push(node);
        }
      }
    }
    const candidates = containers.length > 0
      ? containers
      : [...document.querySelectorAll('a[href]')].filter(anchor => {
          try {
            const url = new URL(anchor.getAttribute('href') ?? '', location.href);
            return /^https?:$/i.test(url.protocol) && url.hostname !== location.hostname;
          } catch {
            return false;
          }
        });
    const seenUrls = new Set();
    const results = candidates.map(node => {
      const anchor = node.matches?.('a[href]') ? node : node.querySelector('h2 a, a.result__a, a[href]');
      const url = decodeResultUrl(anchor?.getAttribute('href') ?? '');
      return {
        title: clean(text(node.querySelector?.('h2') ?? anchor)),
        url,
        snippet: clean(text(node.querySelector?.('.result__snippet, .b_caption p, .b_lineclamp2, .b_lineclamp3, p') ?? node)),
      };
    }).filter(item => {
      if (item.title === '' || !/^https?:\\/\\//i.test(item.url) || seenUrls.has(item.url)) return false;
      seenUrls.add(item.url);
      return true;
    }).slice(0, ${String(limit)});
    return JSON.stringify(results);
  })()`
}

function searchUrl(query, template) {
  const encoded = encodeURIComponent(query)
  if (template.includes('{query}')) return template.replaceAll('{query}', encoded)
  return `${template}${template.includes('?') ? '&' : '?'}q=${encoded}`
}

function providerLabel(url) {
  try {
    return new URL(url).hostname || url
  } catch {
    return url
  }
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
      const trimmed = typeof query === 'string' ? query.trim() : ''
      if (trimmed === '') return { ok: false, error: 'query must not be empty', results: [] }
      const exe = engine()
      if (exe === undefined) return missingEngine()
      const limit = Math.max(1, Math.min(20, positiveInteger(args.limit, config.searchLimit)))
      const settings = policy(args)
      const attempts = []
      const attemptTimeoutMs = Math.min(settings.timeoutMs, config.searchAttemptTimeoutMs)
      for (const template of config.searchUrls) {
        if (signal?.aborted === true) return { ok: false, error: 'search aborted', results: [] }
        const target = searchUrl(trimmed, template)
        const provider = providerLabel(template)
        const started = Date.now()
        const result = runFetch({
          exe,
          args: {
            url: target,
            eval: searchScript(limit),
            wait: 'domcontentloaded',
            delayMs: 600,
            timeoutMs: attemptTimeoutMs,
          },
          maxChars: 100000,
          proxy: settings.proxy,
          insecureTls: settings.insecureTls,
        })
        const elapsedMs = Date.now() - started
        if (result.ok !== true) {
          attempts.push({ provider, searchUrl: target, ok: false, count: 0, elapsedMs, error: String(result.error ?? 'unknown error') })
          continue
        }
        let results
        try {
          results = JSON.parse(result.content)
        } catch {
          attempts.push({ provider, searchUrl: target, ok: false, count: 0, elapsedMs, error: 'the rendered search page did not produce parseable result JSON' })
          continue
        }
        if (!Array.isArray(results)) {
          attempts.push({ provider, searchUrl: target, ok: false, count: 0, elapsedMs, error: 'the search result payload was not an array' })
          continue
        }
        attempts.push({ provider, searchUrl: target, ok: true, count: results.length, elapsedMs })
        if (results.length === 0) continue
        return { ok: true, query: trimmed, provider, searchUrl: target, count: results.length, results, attempts }
      }
      return {
        ok: false,
        query: trimmed,
        error: `all configured search providers failed or returned no results (${String(attempts.length)} tried)`,
        hint: config.proxy === ''
          ? 'The host may block direct browser egress. Set the plugin option `proxy`, or set MOLI_SEARCH_URLS to reachable providers separated by |.'
          : 'Check that the configured proxy is reachable and that at least one provider page exposes ordinary result links. Try moli_fetch on an attempt searchUrl for diagnostics.',
        results: [],
        attempts,
      }
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
            return { content: renderProbeValue({ installed: false, detail: 'moli not found. Re-run with action "install" to download it.' }) }
          }
          const result = probe(exe, 'https://example.com', config.insecureTls)
          return {
            content: renderProbeValue({
              installed: true,
              exe: result.exe,
              version: result.version,
              httpsOk: result.httpsOk,
              detail: result.detail,
              revocationBlock: result.revocationBlock,
            }),
          }
        },
      })
    })

    console.error(`[opencode-moli] ${SERVER_VERSION}: registered websearch provider "moli" and moli_fetch / moli_capture / moli_probe (${cachedExe ?? 'moli missing'})`)
  },
})
