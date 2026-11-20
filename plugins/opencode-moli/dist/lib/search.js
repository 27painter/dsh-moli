/**
 * Shared browser-backed search core: provider list, result extraction, and the
 * relevance guard.
 *
 * Every adapter (DSH, Codex, OpenCode) renders a public search page with Moli and
 * reads the ordinary result links out of it, so all three need the same four
 * things: which provider to try first, the expression that pulls results out of
 * the rendered page, a way to tell a real result set from a page that is not the
 * one that was asked for, and the fallback loop that ties them together.
 *
 * Keeping them here rather than in each adapter is not tidiness. The usage report
 * that prompted this module found the same two defects in both copies of the old
 * per-adapter code (`opencode-moli/src/index.js`, `codex-moli/src/server.mjs`):
 *
 * 1. **The default order was wrong for this network.** Bing was first, and on a
 *    connection where a middlebox swaps responses Bing answered HTTP 200 with
 *    somebody else's results page. The plugin counted that as success, so the
 *    fallbacks were never reached. Measured with the accelerator on: DuckDuckGo
 *    1.2 s, correct; Bing 4.7 s, unrelated pages (a random-string query returned
 *    DuckDuckGo's own page); Brave and cn.bing.com returned matchless pages.
 * 2. **Nothing checked that the results belonged to the query.** "HTTP 200 and a
 *    parsable page" was the whole acceptance test, so a swapped or
 *    anti-bot page became an answer. Wrong answers are worse than errors: the
 *    caller has no reason to retry.
 *
 * @module dsh-moli/lib/search
 */
import { runFetch } from './moli.js';

/**
 * Search providers tried in order, most reliable first.
 *
 * DuckDuckGo's HTML endpoint leads because it was the one measured fast and
 * correct in both halves of the usage report (with the accelerator on, 1.2 s for
 * ten correct results; `wait=domcontentloaded` was enough). Baidu follows because
 * it is the provider that stays reachable when no proxy is available at all; its
 * English/technical results are weaker and its links are one redirect hop away
 * from the real URL, so it is a fallback rather than a default. Bing and Brave
 * keep their place after those two: both can work, neither was reliable on the
 * measured network, and the relevance guard now stops a bad page from being
 * returned as an answer.
 *
 * Overridable with `MOLI_SEARCH_URLS` (or the `searchUrls` plugin option) as a
 * `|`-separated list of URL templates containing `{query}`. The order in that
 * list is the order tried -- putting a different provider first is the documented
 * way to prefer it.
 */
export const DEFAULT_SEARCH_URLS = [
  'https://html.duckduckgo.com/html/?q={query}',
  'https://www.baidu.com/s?wd={query}',
  'https://www.bing.com/search?q={query}',
  'https://search.brave.com/search?q={query}',
];

/** Largest result count a caller may ask for, whatever the adapter's default is. */
export const MAX_SEARCH_LIMIT = 20;

/**
 * Normalize a configured provider list.
 *
 * Accepts the array form (the OpenCode plugin option) and the `|`-separated string
 * form (`MOLI_SEARCH_URLS`, the Codex and OpenCode environment variable), and falls
 * back to {@link DEFAULT_SEARCH_URLS} when nothing usable was supplied. An empty
 * entry from a trailing `|` is dropped rather than tried as a provider.
 *
 * @param value - array, string, or undefined.
 * @returns the provider templates to try, in order.
 */
export function parseSearchUrls(value) {
  const candidates = Array.isArray(value)
    ? value
    : (typeof value === 'string' ? value.split('|') : []);
  const urls = candidates
    .map(candidate => (typeof candidate === 'string' ? candidate.trim() : ''))
    .filter(candidate => candidate !== '');
  return urls.length > 0 ? urls : DEFAULT_SEARCH_URLS;
}

/**
 * Clamp a requested result count into the range the adapters accept.
 *
 * @param value - caller's `limit`, if any.
 * @param fallback - adapter default.
 * @returns a whole number between 1 and {@link MAX_SEARCH_LIMIT}.
 */
export function clampSearchLimit(value, fallback) {
  const limit = Number.isInteger(value) && value > 0 ? value : fallback;
  return Math.max(1, Math.min(MAX_SEARCH_LIMIT, limit));
}

/**
 * Fill a provider template with an encoded query.
 *
 * The `{query}` placeholder is what makes a template unambiguous; a bare URL that
 * carries no placeholder gets `q=` appended so a pasted search URL still works.
 *
 * @param query - the raw query text.
 * @param template - provider URL template.
 * @returns the provider URL to render.
 */
export function searchUrl(query, template) {
  const encoded = encodeURIComponent(query);
  if (template.includes('{query}')) return template.replaceAll('{query}', encoded);
  return `${template}${template.includes('?') ? '&' : '?'}q=${encoded}`;
}

/**
 * Name a provider in an attempt record.
 *
 * @param url - provider template or rendered URL.
 * @returns the hostname, or the input when it does not parse.
 */
export function providerLabel(url) {
  try {
    const parsed = new URL(url);
    // A non-network template (a `data:` or `file:` fixture) has no hostname; its
    // scheme is the only useful label, and a whole data URL in an attempt record
    // would bury the message it belongs to.
    return parsed.hostname || parsed.protocol.replace(/:$/u, '') || url;
  } catch {
    return url;
  }
}

/**
 * Build the expression that reads search results out of the rendered page.
 *
 * Runs inside the engine's page context, so it stays one self-contained function
 * expression. Three parts matter:
 *
 * - **Container selectors come first.** Bing (`li.b_algo`), DuckDuckGo
 *   (`div.result`), Baidu (`div.result` / `div.c-container`) and generic
 *   `[data-testid="result"]` markup are covered; a page whose containers are all
 *   unknown falls back to outgoing links, which is what a plain search page
 *   ultimately is.
 * - **Redirect links are decoded.** Bing wraps targets in `u=a1<base64url>`,
 *   DuckDuckGo in `/l/?uddg=<encoded>`. Returning the wrapper as if it were the
 *   result URL forced every caller to follow it again. Baidu's `link?url=` is an
 *   opaque redirect that cannot be decoded from the page, so it is left as is.
 * - **A "no results" page is not an error.** It yields `[]`, which lets the caller
 *   try the next provider instead of reporting a broken engine.
 *
 * `article` is scoped to Brave: Bing uses `<article>` for unrelated top-story
 * cards, so an unscoped selector turns a no-results page into news hits.
 *
 * @param limit - maximum results to return.
 * @returns a JavaScript expression that evaluates to a JSON array of results.
 */
export function searchScript(limit) {
  return `(() => {
    const decodeResultUrl = href => {
      try {
        const parsed = new URL(href, location.href);
        const duckTarget = parsed.searchParams.get('uddg');
        if (duckTarget !== null && /^https?:\\/\\//i.test(duckTarget)) return duckTarget;
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
    const clean = value => String(value ?? '')
      .replace(/https?:\\/\\/\\S+/giu, '')
      .replace(/\\s+/gu, ' ')
      .replace(/\\s*Read more\\s*$/iu, '')
      .trim()
      .slice(0, 400);
    const noResults = /There are no results|did not match any documents|No results found|No results for|没有找到相关结果/iu.test(document.body === null ? '' : document.body.innerText);
    if (noResults) return JSON.stringify([]);
    const selectors = ['li.b_algo', 'div.result', 'div.snippet[data-type="web"]', 'div.snippet', 'div.c-container', '[data-testid="result"]'];
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
        title: clean(text(node.querySelector?.('h2') ?? anchor)).slice(0, 300),
        url,
        snippet: clean(text(node.querySelector?.('.result__snippet, .b_caption p, .b_lineclamp2, .b_lineclamp3, .c-abstract, p') ?? node)),
      };
    }).filter(item => {
      if (item.title === '' || !/^https?:\\/\\//i.test(item.url) || seenUrls.has(item.url)) return false;
      seenUrls.add(item.url);
      return true;
    }).slice(0, ${String(limit)});
    return JSON.stringify(results);
  })()`;
}

/**
 * Break a query into the probes a result set is matched against.
 *
 * Deliberately loose. The guard exists to catch a page that has nothing to do with
 * the query (a middlebox swapped response, an anti-bot interstitial), not to score
 * relevance, so a single match anywhere in a title, URL, or snippet is enough and
 * a query with no usable token (empty, or one-character) is never rejected.
 *
 * Whitespace-delimited languages -- and CJK, which is not whitespace-delimited --
 * need different probes for the same idea. `北京天气` arrives as one chunk while a
 * result page writes `北京` and `天气` separately, so a CJK chunk contributes its
 * two-character windows as well as itself.
 *
 * @param query - the caller's query.
 * @returns one probe per usable chunk, each carrying the needles that satisfy it.
 */
export function searchProbes(query) {
  const normalized = String(query ?? '').normalize('NFKC').toLowerCase();
  const chunks = normalized
    .split(/[\s\u3000,，.。;；:：!！?？"'“”‘’()（）[\]【】<>《》/\\|·+\-_=*&^%$#@~`]+/u)
    .filter(chunk => chunk !== '');
  const probes = [];
  for (const chunk of chunks) {
    if (chunk.length < 2) continue;
    if (/[\u3400-\u9fff\uf900-\ufaff]/u.test(chunk)) {
      const needles = new Set([chunk]);
      for (let index = 0; index + 2 <= chunk.length && needles.size < 7; index++) {
        needles.add(chunk.slice(index, index + 2));
      }
      probes.push({ chunk, needles: [...needles] });
    } else {
      probes.push({ chunk, needles: [chunk] });
    }
  }
  return probes;
}

/**
 * Measure whether a result set has anything to do with the query.
 *
 * @param query - the caller's query.
 * @param results - extracted results (`title`, `url`, `snippet`).
 * @returns `score` (chunks matched), `total` (chunks probed), `matched` (the
 *   chunks found), and `unknown` when the query had no probe-able token.
 */
export function relevanceScore(query, results) {
  const probes = searchProbes(query);
  const list = Array.isArray(results) ? results : [];
  if (probes.length === 0) return { score: 0, total: 0, matched: [], unknown: true };
  const haystack = list
    .map(result => `${String(result?.title ?? '')} ${String(result?.url ?? '')} ${String(result?.snippet ?? '')}`)
    .join(' ')
    .normalize('NFKC')
    .toLowerCase();
  const matched = probes
    .filter(probe => probe.needles.some(needle => haystack.includes(needle)))
    .map(probe => probe.chunk);
  return { score: matched.length, total: probes.length, matched, unknown: false };
}

/**
 * Decide whether a result set can be returned as an answer to a query.
 *
 * @param query - the caller's query.
 * @param results - extracted results.
 * @returns the relevance record plus `related`, false only when the query had
 *   probed tokens and none of them appeared anywhere in the results.
 */
export function isRelated(query, results) {
  const relevance = relevanceScore(query, results);
  return { ...relevance, related: relevance.unknown === true || relevance.score > 0 };
}

/**
 * Run the provider fallback loop.
 *
 * Synchronous because it stacks synchronous `runFetch` calls: the adapters call it
 * from tool handlers that already return values, and a search that needs two
 * providers should report the second one's results, not a promise.
 *
 * A provider attempt succeeds only when it returns results *and* those results are
 * related to the query (see {@link isRelated}). That second condition is the fix
 * for the report's "silent wrong answer": a swapped page, a consent wall, or an
 * anti-bot interstitial parses fine and used to win the race simply by being first.
 * When nothing qualifies the search fails with every attempt recorded, because a
 * wrong answer is worse than a miss -- the caller can act on a miss.
 *
 * @param options - engine path, query, provider list, policy, and an optional
 *   fetch override (tests inject a fake to exercise the loop without an engine).
 * @returns the canonical search value: `ok`, `results`, `attempts`, and either
 *   `provider`/`count` on success or `error`/`hint` on failure.
 */
export function runSearch(options) {
  const fetch = typeof options.fetch === 'function' ? options.fetch : runFetch;
  const query = String(options.query ?? '').trim();
  if (query === '') return { ok: false, error: 'query must not be empty', results: [] };
  const limit = clampSearchLimit(options.limit, 10);
  const urls = parseSearchUrls(options.urls);
  const attemptTimeoutMs = Number.isInteger(options.attemptTimeoutMs) && options.attemptTimeoutMs > 0
    ? options.attemptTimeoutMs
    : 20000;
  const attempts = [];
  let sawUnrelated = false;
  for (const template of urls) {
    if (typeof options.isAborted === 'function' && options.isAborted() === true) {
      return { ok: false, query, error: 'search aborted', results: [], attempts };
    }
    const target = searchUrl(query, template);
    const provider = providerLabel(template);
    const started = Date.now();
    const result = fetch({
      exe: options.exe,
      args: {
        url: target,
        // `wait: 'domcontentloaded'` is the measured best setting for a search page:
        // DuckDuckGo answered in 1.0 s with it against 5.2 s for `load` and 3.3 s for
        // `done`, with the same ten results. The small delay covers result markup
        // that arrives just after the document.
        eval: searchScript(limit),
        wait: 'domcontentloaded',
        delayMs: 600,
        timeoutMs: Math.min(options.timeoutMs ?? attemptTimeoutMs, attemptTimeoutMs),
      },
      maxChars: 100000,
      proxy: options.proxy,
      insecureTls: options.insecureTls,
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
    if (results.length === 0) {
      attempts.push({ provider, searchUrl: target, ok: false, count: 0, elapsedMs, error: 'the search page reported no results' });
      continue;
    }
    const relevance = isRelated(query, results);
    if (relevance.related !== true) {
      sawUnrelated = true;
      attempts.push({
        provider,
        searchUrl: target,
        ok: false,
        count: results.length,
        elapsedMs,
        rejected: true,
        relevance,
        error: `${String(results.length)} result(s) had nothing in common with the query (none of ${String(relevance.total)} query term(s) appeared in any title, URL, or snippet), so this page was not an answer`,
      });
      continue;
    }
    attempts.push({ provider, searchUrl: target, ok: true, count: results.length, elapsedMs, relevance });
    return {
      ok: true,
      query,
      provider,
      searchUrl: target,
      count: results.length,
      resultCount: results.length,
      results,
      attempts,
      relevance,
    };
  }
  return {
    ok: false,
    query,
    error: sawUnrelated
      ? `every configured search provider failed, returned no results, or returned results unrelated to the query (${String(attempts.length)} tried)`
      : `all configured search providers failed or returned no results (${String(attempts.length)} tried)`,
    hint: sawUnrelated
      ? 'The providers that answered returned pages unrelated to this query -- a response swapped in transit, an anti-bot interstitial, or a login wall is the usual cause. Try a different provider with MOLI_SEARCH_URLS, or retry once the page is reachable.'
      : (options.proxy === undefined || options.proxy === ''
        ? 'The host may block direct browser egress. Set the plugin option `proxy` (or MOLI_PROXY / HTTPS_PROXY), or set MOLI_SEARCH_URLS to reachable providers separated by |.'
        : 'Check that the configured proxy is reachable and that at least one provider page exposes ordinary result links. Try moli_fetch on an attempt searchUrl for diagnostics.'),
    results: [],
    attempts,
    ...(options.diagnostics === undefined ? {} : { diagnostics: options.diagnostics }),
  };
}