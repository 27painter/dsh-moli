#!/usr/bin/env node
/**
 * Codex-facing MCP server for the local Moli browser.
 *
 * This adapter intentionally uses only Node built-ins and the repository's
 * host-neutral browser core. The build script copies that core into dist/lib so
 * the installed plugin is self-contained after Codex snapshots its directory.
 */
import { findMoli, moliCandidates, moliVersion, probe, runFetch } from './lib/moli.js';
import { MANUAL_INSTALL, installMoli } from './lib/install.js';

const SERVER_NAME = 'moli';
const SERVER_VERSION = '3.1.0';
const DEFAULT_PROTOCOL_VERSION = '2025-06-18';
const DEFAULT_SEARCH_URLS = [
  'https://www.bing.com/search?q={query}',
  'https://html.duckduckgo.com/html/?q={query}',
  'https://search.brave.com/search?q={query}',
];

function positiveInteger(value, fallback) {
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

function envBoolean(value, fallback = false) {
  if (typeof value !== 'string' || value.trim() === '') return fallback;
  return /^(1|true|yes|on)$/iu.test(value.trim());
}

function searchUrlList() {
  const configured = process.env.MOLI_SEARCH_URLS?.trim() || process.env.MOLI_SEARCH_URL?.trim() || '';
  if (configured === '') return DEFAULT_SEARCH_URLS;
  const urls = configured.split('|').map(url => url.trim()).filter(url => url !== '');
  return urls.length > 0 ? urls : DEFAULT_SEARCH_URLS;
}

const config = {
  exePath: process.env.MOLI_BIN?.trim() || '',
  proxy: process.env.MOLI_PROXY?.trim()
    || process.env.HTTPS_PROXY?.trim()
    || process.env.HTTP_PROXY?.trim()
    || process.env.ALL_PROXY?.trim()
    || '',
  searchUrls: searchUrlList(),
  defaultTimeoutMs: positiveInteger(Number(process.env.MOLI_TIMEOUT_MS), 30000),
  searchAttemptTimeoutMs: positiveInteger(Number(process.env.MOLI_SEARCH_ATTEMPT_TIMEOUT_MS), 20000),
  maxChars: positiveInteger(Number(process.env.MOLI_MAX_CHARS), 200000),
  installTimeoutMs: positiveInteger(Number(process.env.MOLI_INSTALL_TIMEOUT_MS), 180000),
  insecureTls: envBoolean(process.env.MOLI_INSECURE_TLS, false),
};

let cachedExe = findMoli(config.exePath);
const engine = () => cachedExe;

const FETCH_INPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['url'],
  properties: {
    url: { type: 'string', description: 'Absolute http:// or https:// URL to render.' },
    dump: {
      type: 'string',
      enum: ['html', 'markdown', 'json', 'semantic_tree', 'semantic_tree_text', 'screenshot', 'screenshot_full', 'pdf'],
      description: 'Output format. Omit for rendered HTML. Markdown is the most compact full-page reading format. Screenshot and PDF require writeTo.',
    },
    writeTo: {
      type: 'string',
      description: 'Absolute output path. Required for screenshots and PDF; optional for text dumps.',
    },
    selector: {
      type: 'string',
      description: 'Return only the text of elements matching this CSS selector. Cannot be combined with dump or eval.',
    },
    eval: {
      type: 'string',
      description: 'JavaScript expression evaluated after the page is ready. Use it alone to return its value. With dump, its value is discarded and only the resulting page is returned.',
    },
    scroll: {
      type: 'string',
      description: 'Scroll before capture: pixels as a string, or top/bottom.',
    },
    wait: {
      type: 'string',
      enum: ['domcontentloaded', 'load', 'networkidle', 'domstable', 'done'],
      description: 'Readiness stage. Defaults to done.',
    },
    waitSelector: { type: 'string', description: 'Wait until this CSS selector matches.' },
    waitScript: { type: 'string', description: 'Wait until this JavaScript expression is truthy.' },
    waitResponseUrl: { type: 'string', description: 'Wait for a response URL containing this substring.' },
    waitResponseJson: { type: 'string', description: 'Wait for a JSON response field matching PATH=VALUE.' },
    failOnHttpError: { type: 'boolean', description: 'Return ok:false for final HTTP status 400 or above while preserving the body.' },
    delayMs: { type: 'integer', minimum: 0, description: 'Extra delay after readiness.' },
    timeoutMs: { type: 'integer', minimum: 1, description: 'Readiness deadline in milliseconds.' },
    maxChars: { type: 'integer', minimum: 1, description: 'Inline text truncation budget.' },
    headers: { type: 'array', items: { type: 'string' }, description: 'Extra request headers as Name: value.' },
    userAgent: { type: 'string', description: 'Override the User-Agent.' },
    layout: { type: 'boolean', description: 'Enable the layout renderer.' },
    scrollbars: { type: 'boolean', description: 'Show scrollbars in rendered output.' },
    noJs: { type: 'boolean', description: 'Disable page-authored JavaScript.' },
    noCss: { type: 'boolean', description: 'Disable page-authored CSS.' },
    resources: { type: 'boolean', description: 'Fetch optional media and text-track resources.' },
    withFrames: { type: 'boolean', description: 'Include subframes in output.' },
    insecureTls: { type: 'boolean', description: 'Skip TLS host verification for this call.' },
    proxy: { type: 'string', description: 'Forward proxy for this call.' },
    profileDir: { type: 'string', description: 'Moli profile directory.' },
    cookieFile: { type: 'string', description: 'Netscape/curl cookie-jar file.' },
  },
};

const SEARCH_INPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['query'],
  properties: {
    query: { type: 'string', minLength: 1, description: 'Web search query.' },
    limit: { type: 'integer', minimum: 1, maximum: 20, description: 'Maximum results to return. Defaults to 10.' },
    timeoutMs: { type: 'integer', minimum: 1, description: 'Search page readiness deadline.' },
    proxy: { type: 'string', description: 'Forward proxy for this call.' },
  },
};

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
};

const PROBE_INPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    action: { type: 'string', enum: ['probe', 'install'], description: 'probe reports the local install; install downloads and executes the official Moli installer.' },
    expectedSha256: { type: 'string', description: 'During install, refuse to execute unless the installer digest matches.' },
    checkHttps: { type: 'boolean', description: 'During probe, also test an HTTPS fetch in the MCP server process.' },
  },
};

const VALUE_OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: true,
  properties: {
    ok: { type: 'boolean' },
    installed: { type: 'boolean' },
    error: { type: 'string' },
    hint: { type: 'string' },
    url: { type: 'string' },
    query: { type: 'string' },
    content: { type: 'string' },
    path: { type: 'string' },
    status: { type: 'integer' },
    count: { type: 'integer' },
    provider: { type: 'string' },
    proxy: { type: 'string' },
    attempts: { type: 'array', items: { type: 'object', additionalProperties: true } },
    diagnostics: { type: 'object', additionalProperties: true },
    results: { type: 'array', items: { type: 'object', additionalProperties: true } },
  },
};

const TOOL_DEFINITIONS = [
  {
    name: 'moli_search',
    title: 'Search the web with Moli',
    description: 'Search the public web through the local Moli headless browser and return structured result titles, URLs, and snippets. Use this when the user asks for current or external web information.',
    inputSchema: SEARCH_INPUT_SCHEMA,
    outputSchema: VALUE_OUTPUT_SCHEMA,
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
  },
  {
    name: 'moli_fetch',
    title: 'Fetch a rendered page with Moli',
    description: 'Open a URL in the local Moli headless browser and return rendered Markdown, HTML, a semantic tree, a JSON envelope, a selector match, or a JavaScript evaluation result.',
    inputSchema: FETCH_INPUT_SCHEMA,
    outputSchema: VALUE_OUTPUT_SCHEMA,
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
  },
  {
    name: 'moli_capture',
    title: 'Capture a page as PNG or PDF',
    description: 'Render a page in Moli and write a screenshot or PDF to an explicit output path.',
    inputSchema: CAPTURE_INPUT_SCHEMA,
    outputSchema: VALUE_OUTPUT_SCHEMA,
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
  },
  {
    name: 'moli_probe',
    title: 'Inspect or install Moli',
    description: 'Report the local Moli executable and version, optionally test HTTPS, or explicitly download and execute the official installer.',
    inputSchema: PROBE_INPUT_SCHEMA,
    outputSchema: VALUE_OUTPUT_SCHEMA,
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
  },
];

function searchUrl(query, template) {
  const encoded = encodeURIComponent(query);
  if (template.includes('{query}')) return template.replaceAll('{query}', encoded);
  return `${template}${template.includes('?') ? '&' : '?'}q=${encoded}`;
}

function providerLabel(url) {
  try {
    const parsed = new URL(url);
    return parsed.hostname || parsed.protocol.replace(/:$/u, '') || url;
  } catch {
    return url;
  }
}

function searchDiagnostics(proxy) {
  return {
    proxy: proxy === '' ? null : proxy,
    providers: config.searchUrls.map(providerLabel),
    insecureTls: config.insecureTls,
    engine: cachedExe ?? null,
  };
}

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
    const containers = [];
    const seenNodes = new Set();
    for (const selector of ['li.b_algo', 'div.snippet[data-type="web"]', 'div.snippet', '[data-testid="result"]', 'article']) {
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
      const anchor = node.matches?.('a[href]') ? node : node.querySelector('h2 a, a[href]');
      const url = decodeResultUrl(anchor?.getAttribute('href') ?? '');
      return {
        title: text(anchor),
        url,
        snippet: text(node.querySelector?.('.b_caption p, .b_lineclamp2, .b_lineclamp3, p') ?? node),
      };
    }).filter(item => {
      if (item.title === '' || !/^https?:\\/\\//i.test(item.url) || seenUrls.has(item.url)) return false;
      seenUrls.add(item.url);
      return true;
    }).slice(0, ${String(limit)});
    return JSON.stringify(results);
  })()`;
}

function missingEngine() {
  return {
    ok: false,
    error: 'moli was not found',
    hint: 'Call moli_probe with action "install", set MOLI_BIN, or install Moli from the official release.',
    manualInstall: MANUAL_INSTALL,
  };
}

function callPolicy(args) {
  return {
    timeoutMs: positiveInteger(args.timeoutMs, config.defaultTimeoutMs),
    maxChars: positiveInteger(args.maxChars, config.maxChars),
    proxy: typeof args.proxy === 'string' && args.proxy !== '' ? args.proxy : config.proxy,
    insecureTls: typeof args.insecureTls === 'boolean' ? args.insecureTls : config.insecureTls,
  };
}

function executeFetch(args) {
  const exe = engine();
  if (exe === undefined) return missingEngine();
  const policy = callPolicy(args);
  return runFetch({
    exe,
    args: { ...args, timeoutMs: policy.timeoutMs },
    maxChars: policy.maxChars,
    proxy: policy.proxy,
    insecureTls: policy.insecureTls,
  });
}

function executeCapture(args) {
  return executeFetch(args);
}

function executeSearch(args) {
  const query = typeof args.query === 'string' ? args.query.trim() : '';
  if (query === '') return { ok: false, error: 'query must not be empty', results: [] };
  const exe = engine();
  if (exe === undefined) return missingEngine();
  const limit = Math.max(1, Math.min(20, positiveInteger(args.limit, 10)));
  const policy = callPolicy(args);
  const attempts = [];
  const attemptTimeoutMs = Math.min(policy.timeoutMs, config.searchAttemptTimeoutMs);
  for (const template of config.searchUrls) {
    const target = searchUrl(query, template);
    const provider = providerLabel(template);
    const started = Date.now();
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
      proxy: policy.proxy,
      insecureTls: policy.insecureTls,
    });
    const elapsedMs = Date.now() - started;
    if (result.ok !== true) {
      attempts.push({ provider, searchUrl: target, ok: false, count: 0, elapsedMs, error: String(result.error ?? 'unknown error') });
      continue;
    }
    let results;
    try {
      results = JSON.parse(result.content);
    } catch {
      attempts.push({ provider, searchUrl: target, ok: false, count: 0, elapsedMs, error: 'the rendered search page did not produce parseable result JSON' });
      continue;
    }
    if (!Array.isArray(results)) {
      attempts.push({ provider, searchUrl: target, ok: false, count: 0, elapsedMs, error: 'the search result payload was not an array' });
      continue;
    }
    attempts.push({ provider, searchUrl: target, ok: true, count: results.length, elapsedMs });
    if (results.length === 0) continue;
    return {
      ok: true,
      query,
      provider,
      searchUrl: target,
      count: results.length,
      results,
      attempts,
      diagnostics: searchDiagnostics(policy.proxy),
    };
  }
  const diagnostics = searchDiagnostics(policy.proxy);
  return {
    ok: false,
    query,
    error: `all configured search providers failed or returned no results (${String(attempts.length)} tried)`,
    hint: diagnostics.proxy === null
      ? 'The host may block direct browser egress. Set MOLI_PROXY to a working forward proxy, or set MOLI_SEARCH_URLS to reachable providers separated by |.'
      : 'Check that the configured proxy is reachable and that at least one provider page exposes ordinary result links. Try moli_fetch on an attempt searchUrl for diagnostics.',
    results: [],
    attempts,
    diagnostics,
  };
}

async function executeProbe(args) {
  if (args.action === 'install') {
    const outcome = await installMoli({
      exePath: config.exePath,
      expectedSha256: args.expectedSha256,
      timeoutMs: config.installTimeoutMs,
      proxy: config.proxy,
      locate: findMoli,
      candidates: moliCandidates(config.exePath),
    });
    if (outcome.ok === true) cachedExe = outcome.exe;
    return { ...outcome, installed: outcome.ok === true };
  }
  const exe = engine();
  if (exe === undefined) {
    return { installed: false, ok: false, detail: 'moli was not found', manualInstall: MANUAL_INSTALL, diagnostics: searchDiagnostics(config.proxy) };
  }
  const version = moliVersion(exe) ?? 'unknown';
  if (args.checkHttps !== true) {
    return { installed: true, ok: true, exe, version, httpsOk: undefined, httpsOkScope: 'not checked', diagnostics: searchDiagnostics(config.proxy) };
  }
  const result = probe(exe, 'https://example.com', config.insecureTls);
  return {
    installed: true,
    ok: result.httpsOk === true,
    exe,
    version,
    httpsOk: result.httpsOk,
    httpsOkScope: result.httpsOkScope,
    sandboxTlsBlock: result.sandboxTlsBlock,
    revocationBlock: result.revocationBlock,
    detail: result.detail,
    diagnostics: searchDiagnostics(config.proxy),
  };
}

function renderFetchValue(value) {
  if (value.ok !== true) {
    const lines = [`Moli fetch failed${typeof value.url === 'string' ? ` for ${value.url}` : ''}: ${String(value.error ?? 'unknown error')}`];
    if (typeof value.status === 'number') lines.push(`HTTP status: ${String(value.status)}`);
    if (typeof value.hint === 'string' && value.hint !== '') lines.push(`Next: ${value.hint}`);
    if (typeof value.content === 'string' && value.content !== '') lines.push('', value.content);
    return lines.join('\n');
  }
  if (value.kind === 'binary') {
    return `${String(value.dump)} written to ${String(value.path)} (${String(value.bytes)} bytes).`;
  }
  const parts = [];
  if (value.evalDiscarded === true) {
    parts.push('The eval expression was discarded because dump was also supplied; the content is the resulting page, not the expression value.');
  }
  if (typeof value.selector === 'string' && typeof value.matched === 'number') {
    parts.push(`Selector ${JSON.stringify(value.selector)} matched ${String(value.matched)} element(s).`);
  }
  if (typeof value.note === 'string' && value.note !== '') parts.push(value.note);
  parts.push(String(value.content ?? ''));
  return parts.join('\n\n');
}

function renderSearchValue(value) {
  if (value.ok !== true) {
    const lines = [`Moli search failed for ${JSON.stringify(value.query ?? '')}: ${String(value.error ?? 'unknown error')}`];
    if (Array.isArray(value.attempts) && value.attempts.length > 0) {
      lines.push('Providers tried:');
      for (const attempt of value.attempts) {
        lines.push(`- ${String(attempt.provider)}: ${String(attempt.error ?? `no results (${String(attempt.count ?? 0)})`)}`);
      }
    }
    if (typeof value.hint === 'string' && value.hint !== '') lines.push(`Next: ${value.hint}`);
    return lines.join('\n');
  }
  const results = Array.isArray(value.results) ? value.results : [];
  if (results.length === 0) return `Moli search returned no results for ${JSON.stringify(value.query)}. ${String(value.note ?? '')}`.trim();
  const provider = typeof value.provider === 'string' ? ` via ${value.provider}` : '';
  const lines = [`Moli search found ${String(results.length)} result(s) for ${JSON.stringify(value.query)}${provider}:`, ''];
  results.forEach((result, index) => {
    lines.push(`${String(index + 1)}. ${String(result.title ?? '(untitled)')}`);
    lines.push(`   ${String(result.url ?? '')}`);
    if (typeof result.snippet === 'string' && result.snippet !== '') lines.push(`   ${result.snippet}`);
  });
  return lines.join('\n');
}

function renderProbeValue(value) {
  if (value.installed !== true) {
    const lines = [`Moli is not installed: ${String(value.error ?? value.detail ?? 'not found')}`];
    if (typeof value.hint === 'string' && value.hint !== '') lines.push(`Next: ${value.hint}`);
    return lines.join('\n');
  }
  const lines = [`${String(value.version)} at ${String(value.exe)}`];
  const diagnostics = value.diagnostics;
  if (diagnostics !== null && typeof diagnostics === 'object') {
    lines.push(`Proxy: ${diagnostics.proxy === null ? 'not configured' : String(diagnostics.proxy)}`);
    if (Array.isArray(diagnostics.providers) && diagnostics.providers.length > 0) {
      lines.push(`Search providers: ${diagnostics.providers.join(', ')}`);
    }
  }
  if (value.ok === true && value.httpsOk === true) lines.push('HTTPS fetch succeeded from the MCP server process.');
  else if (value.httpsOk === false) lines.push(`HTTPS check failed: ${String(value.detail ?? value.error ?? 'unknown error')}`);
  else lines.push('HTTPS check was not requested.');
  return lines.join('\n');
}

function renderToolValue(name, value) {
  if (name === 'moli_search') return renderSearchValue(value);
  if (name === 'moli_probe') return renderProbeValue(value);
  return renderFetchValue(value);
}

async function executeTool(name, args) {
  const input = args !== null && typeof args === 'object' && !Array.isArray(args) ? args : {};
  switch (name) {
    case 'moli_search':
      return executeSearch(input);
    case 'moli_fetch':
      return executeFetch(input);
    case 'moli_capture':
      return executeCapture(input);
    case 'moli_probe':
      return executeProbe(input);
    default:
      return { ok: false, error: `unknown tool: ${String(name)}` };
  }
}

function writeMessage(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function writeResult(id, result) {
  writeMessage({ jsonrpc: '2.0', id, result });
}

function writeError(id, code, message, data) {
  writeMessage({
    jsonrpc: '2.0',
    id,
    error: { code, message, ...(data === undefined ? {} : { data }) },
  });
}

async function handleRequest(message) {
  const { id, method, params } = message;
  if (method === 'initialize') {
    const requested = params?.protocolVersion;
    writeResult(id, {
      protocolVersion: typeof requested === 'string' && requested !== '' ? requested : DEFAULT_PROTOCOL_VERSION,
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
      instructions: 'Moli provides browser-backed web search, rendered page fetching, screenshots, and PDFs. Search first when current web information is needed, then fetch a promising result URL for full page content.',
    });
    return;
  }
  if (method === 'ping') {
    writeResult(id, {});
    return;
  }
  if (method === 'tools/list') {
    writeResult(id, { tools: TOOL_DEFINITIONS });
    return;
  }
  if (method === 'tools/call') {
    const name = typeof params?.name === 'string' ? params.name : '';
    const value = await executeTool(name, params?.arguments);
    const isError = value.ok === false || (name === 'moli_probe' && value.installed === false);
    writeResult(id, {
      content: [{ type: 'text', text: renderToolValue(name, value) }],
      structuredContent: value,
      isError,
    });
    return;
  }
  if (method === 'logging/setLevel') {
    writeResult(id, {});
    return;
  }
  writeError(id, -32601, `method not found: ${String(method)}`);
}

async function handleMessage(message) {
  if (Array.isArray(message)) {
    for (const entry of message) await handleMessage(entry);
    return;
  }
  if (message === null || typeof message !== 'object') return;
  const hasId = Object.prototype.hasOwnProperty.call(message, 'id');
  if (!hasId) {
    // notifications/initialized and cancellation notifications need no response.
    return;
  }
  try {
    await handleRequest(message);
  } catch (error) {
    writeError(message.id, -32603, `internal error: ${String(error?.message ?? error)}`);
  }
}

let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => {
  buffer += chunk;
  while (true) {
    const newline = buffer.indexOf('\n');
    if (newline < 0) break;
    const line = buffer.slice(0, newline).replace(/\r$/u, '');
    buffer = buffer.slice(newline + 1);
    if (line.trim() === '') continue;
    let message;
    try {
      message = JSON.parse(line);
    } catch (error) {
      writeError(null, -32700, `parse error: ${String(error?.message ?? error)}`);
      continue;
    }
    void handleMessage(message);
  }
});

process.stdin.on('end', () => {
  if (buffer.trim() !== '') {
    try {
      void handleMessage(JSON.parse(buffer));
    } catch (error) {
      writeError(null, -32700, `parse error: ${String(error?.message ?? error)}`);
    }
  }
});

process.on('SIGTERM', () => process.exit(0));
process.on('SIGINT', () => process.exit(0));
