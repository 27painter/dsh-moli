// Regression guard for the usage report that shipped v3.2.0 (2026-11-20).
//
// Three findings drive the assertions here, and all three share one shape: the
// plugin reported success while answering the wrong question.
//
//   1. The default provider order was Bing -> DuckDuckGo -> Brave. On the measured
//      network Bing answered HTTP 200 with somebody else's results page, so the
//      fallbacks were never reached: a random-string query came back as
//      DuckDuckGo's own page, another as a hospital's cardiology page.
//   2. Nothing compared the results to the query, so a swapped page or an anti-bot
//      interstitial was accepted as an answer. "HTTP 200 and parsable" was the
//      whole acceptance test.
//   3. Redirect links were returned as if they were results -- Bing `u=a1<base64>`
//      and DuckDuckGo `/l/?uddg=` -- so every caller had to follow them again.
//
// The page-expression half runs against a fake DOM rather than a live search page,
// which is what makes this suite offline and deterministic: what is being tested is
// the extraction and the decision, not the provider's markup of the day.
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const REPO = dirname(here);

let pass = 0;
let fail = 0;
const check = (label, ok, extra = '') => {
  if (ok) { pass++; console.log(`  PASS ${label}${extra ? ` -- ${extra}` : ''}`); }
  else { fail++; console.log(`  FAIL ${label}${extra ? ` -- ${extra}` : ''}`); }
};

const {
  DEFAULT_SEARCH_URLS,
  clampSearchLimit,
  isRelated,
  parseSearchUrls,
  providerLabel,
  relevanceScore,
  runSearch,
  searchProbes,
  searchScript,
  searchUrl,
} = await import(pathToFileURL(join(REPO, 'lib', 'search.js')).href);

// ---------------------------------------------------------------------------
// A DOM small enough to reason about. The injected expression only uses
// querySelectorAll, innerText/textContent, matches, getAttribute, location.href and
// document.body.innerText, so that is all this provides.
const anchorNode = (href, label = '') => ({
  innerText: label,
  textContent: label,
  getAttribute: () => href,
  matches: selector => selector === 'a[href]',
  querySelector: () => null,
});
const textNode = text => ({ innerText: text, textContent: text, getAttribute: () => null, matches: () => false, querySelector: () => null });
const resultContainer = ({ title, href, snippet }) => {
  const anchor = anchorNode(href);
  return {
    innerText: '',
    textContent: `${title} ${snippet}`,
    getAttribute: () => null,
    matches: () => false,
    querySelector(selector) {
      if (selector === 'h2 a, a.result__a, a[href]') return anchor;
      if (selector === 'h2') return title === undefined ? null : textNode(title);
      if (selector.includes('result__snippet')) return snippet === undefined ? null : textNode(snippet);
      return null;
    },
  };
};
const page = ({ bodyText = '', bySelector = {}, anchors = [], hostname = 'html.duckduckgo.com' }) => ({
  document: {
    body: { innerText: bodyText },
    querySelectorAll(selector) {
      return bySelector[selector] ?? (selector === 'a[href]' ? anchors : []);
    },
  },
  location: { href: `https://${hostname}/`, hostname },
});
/** Evaluate the injected expression against a fixture page. */
const evaluate = (script, fixture) => new Function('document', 'location', `return ${script};`)(fixture.document, fixture.location);

console.log('1. the default provider order leads with the one that worked');
check('DuckDuckGo HTML is first', /html\.duckduckgo\.com\/html/u.test(DEFAULT_SEARCH_URLS[0]), DEFAULT_SEARCH_URLS[0]);
check('Baidu is the no-proxy fallback that follows it', /baidu\.com/u.test(DEFAULT_SEARCH_URLS[1]), DEFAULT_SEARCH_URLS[1]);
check('Bing is no longer first', !/bing\.com/u.test(DEFAULT_SEARCH_URLS[0]));
check('Bing is still tried, just later', DEFAULT_SEARCH_URLS.some(url => /bing\.com/u.test(url)));
check('Brave is still tried, just later', DEFAULT_SEARCH_URLS.some(url => /brave\.com/u.test(url)));
check('every default takes a {query} placeholder', DEFAULT_SEARCH_URLS.every(url => url.includes('{query}')));

console.log('\n2. a provider list is parsed without losing its order');
check('the | form splits in order',
  JSON.stringify(parseSearchUrls('https://a.example/?q={query}|https://b.example/?q={query}'))
  === JSON.stringify(['https://a.example/?q={query}', 'https://b.example/?q={query}']));
check('the array form is accepted',
  JSON.stringify(parseSearchUrls(['https://a.example/?q={query}'])) === JSON.stringify(['https://a.example/?q={query}']));
check('a trailing pipe does not create an empty provider', parseSearchUrls('https://a.example/?q={query}|').length === 1);
check('surrounding whitespace is trimmed', parseSearchUrls('  https://a.example/?q={query}  ')[0] === 'https://a.example/?q={query}');
check('an empty string falls back to the defaults',
  JSON.stringify(parseSearchUrls('')) === JSON.stringify(DEFAULT_SEARCH_URLS));
check('undefined falls back to the defaults',
  JSON.stringify(parseSearchUrls(undefined)) === JSON.stringify(DEFAULT_SEARCH_URLS));
check('a provider label is its hostname', providerLabel('https://html.duckduckgo.com/html/?q=x') === 'html.duckduckgo.com');

console.log('\n3. the query is filled in and the limit is clamped');
check('{query} is encoded', searchUrl('a b', 'https://s.example/?q={query}') === 'https://s.example/?q=a%20b');
check('a template without a placeholder still gets q=', searchUrl('a b', 'https://s.example/search') === 'https://s.example/search?q=a%20b');
check('an existing query string is extended with &', searchUrl('a', 'https://s.example/search?x=1') === 'https://s.example/search?x=1&q=a');
check('the limit cap is 20', clampSearchLimit(99, 10) === 20);
check('a non-integer limit falls back to the adapter default', clampSearchLimit(undefined, 10) === 10);
check('a zero limit is not a limit of zero', clampSearchLimit(0, 7) === 7);

console.log('\n4. the page expression extracts, decodes, and reports no-results');
const bingTarget = 'https://example.com/bing-target';
const bingToken = 'a1' + Buffer.from(bingTarget, 'utf8').toString('base64')
  .replace(/\+/gu, '-').replace(/\//gu, '_').replace(/=+$/u, '');
const duckTarget = 'https://github.com/lexmount/moli';
const duckPage = page({
  bySelector: {
    'div.result': [
      resultContainer({ title: 'lexmount/moli', href: `//duckduckgo.com/l/?uddg=${encodeURIComponent(duckTarget)}`, snippet: 'A headless browser in Rust' }),
      resultContainer({ title: 'Docs', href: 'https://example.com/docs', snippet: 'Documentation' }),
    ],
  },
});
const duckResults = JSON.parse(evaluate(searchScript(5), duckPage));
check('results are extracted from the containers', duckResults.length === 2, `${duckResults.length}`);
check('the DuckDuckGo redirect is decoded to the real target', duckResults[0].url === duckTarget, duckResults[0].url);
check('the title comes from the heading', duckResults[0].title === 'lexmount/moli', duckResults[0].title);
check('the snippet comes from the snippet node', /headless browser/u.test(duckResults[0].snippet), duckResults[0].snippet);
check('a plain result url is left alone', duckResults[1].url === 'https://example.com/docs');

const bingPage = page({
  hostname: 'www.bing.com',
  bySelector: { 'li.b_algo': [resultContainer({ title: 'Bing hit', href: `/ck/a?u=${bingToken}`, snippet: 'snippet' })] },
});
const bingResults = JSON.parse(evaluate(searchScript(5), bingPage));
check('the Bing u=a1 redirect is decoded to the real target', bingResults[0].url === bingTarget, bingResults[0].url);

check('a no-results page yields an empty array',
  evaluate(searchScript(5), page({ bodyText: 'No results found for that query' })) === '[]');
const anchorFallback = JSON.parse(evaluate(searchScript(5), page({
  anchors: [
    anchorNode('https://example.com/outer', 'Outer result'),
    anchorNode('https://html.duckduckgo.com/about', 'About this engine'),
  ],
})));
check('an unknown container falls back to outgoing links', anchorFallback.length === 1, `${anchorFallback.length}`);
check('and drops links pointing back at the engine', anchorFallback[0].url === 'https://example.com/outer', anchorFallback[0].url);

const braveHit = resultContainer({ title: 'Brave hit', href: 'https://example.com/brave', snippet: 'x' });
check('Brave results in <article> are read',
  JSON.parse(evaluate(searchScript(5), page({ hostname: 'search.brave.com', bySelector: { article: [braveHit] } }))).length === 1);
check('Bing top-story <article> cards are not read as results',
  evaluate(searchScript(5), page({ hostname: 'www.bing.com', bySelector: { article: [braveHit] } })) === '[]');

console.log('\n5. the relevance guard rejects a page that is not the answer');
const swapped = [{ title: 'Deloitte - Sign in to your account', url: 'https://deloitte.example/login', snippet: 'Sign in to your account' }];
const relevant = [{ title: 'lexmount/moli', url: 'https://github.com/lexmount/moli', snippet: 'A headless browser written in Rust' }];
check('a swapped page has nothing in common with the query',
  isRelated('moli headless browser rust', swapped).related === false);
check('one matching term is enough to accept', isRelated('moli headless browser rust', relevant).related === true);
check('the match may be in the url alone',
  isRelated('lexmount', [{ title: 'x', url: 'https://github.com/lexmount/moli', snippet: '' }]).related === true);
check('the score counts matched terms', relevanceScore('moli rust', relevant).score === 2,
  JSON.stringify(relevanceScore('moli rust', relevant)));
check('CJK is matched by two-character windows (the query has no spaces)',
  isRelated('北京天气', [{ title: '北京今日天气', url: 'https://weather.example/', snippet: '' }]).related === true);
check('a CJK page about somewhere else is rejected',
  isRelated('北京天气', [{ title: '上海新闻', url: 'https://news.example/', snippet: '' }]).related === false);
check('a query with no probe-able token is never rejected',
  isRelated('a', swapped).related === true && isRelated('a', swapped).unknown === true);
check('an empty query list of probes is reported as unknown', searchProbes('').length === 0);

console.log('\n6. the fallback loop fails instead of answering the wrong question');
const WRONG = swapped;
const RIGHT = relevant;
const fetchFrom = table => options => {
  const hostname = new URL(options.args.url).hostname;
  const entry = table[hostname];
  if (entry === undefined) return { ok: false, url: options.args.url, error: `no fixture for ${hostname}` };
  if (entry.error !== undefined) return { ok: false, url: options.args.url, error: entry.error };
  return { ok: true, url: options.args.url, content: JSON.stringify(entry.results) };
};
const base = {
  exe: 'moli',
  query: 'moli headless browser rust',
  urls: 'https://a.example/?q={query}|https://b.example/?q={query}',
  timeoutMs: 5000,
  attemptTimeoutMs: 5000,
};

const fell = runSearch({ ...base, fetch: fetchFrom({ 'a.example': { results: WRONG }, 'b.example': { results: RIGHT } }) });
check('a swapped page falls through to the next provider', fell.ok === true && fell.provider === 'b.example', String(fell.provider));
check('the providers are tried in the configured order',
  JSON.stringify(fell.attempts.map(attempt => attempt.provider)) === JSON.stringify(['a.example', 'b.example']));
check('both attempts are recorded', fell.attempts.length === 2, `${fell.attempts.length}`);
check('the first attempt is marked rejected', fell.attempts[0].rejected === true && fell.attempts[0].ok === false);
check('the rejection reports how many results were discarded', fell.attempts[0].count === WRONG.length);
check('the rejection says why', /nothing in common with the query/u.test(String(fell.attempts[0].error)),
  JSON.stringify(String(fell.attempts[0].error).slice(0, 70)));
check('the returned results are the related ones', fell.results[0].url === RIGHT[0].url);
check('the relevance record travels with the success', fell.relevance?.score > 0, JSON.stringify(fell.relevance));

const allWrong = runSearch({ ...base, fetch: fetchFrom({ 'a.example': { results: WRONG }, 'b.example': { results: WRONG } }) });
check('when every provider is unrelated the search fails', allWrong.ok === false, String(allWrong.ok));
check('and returns no results rather than unrelated ones', allWrong.results.length === 0);
check('the error says the results were unrelated', /unrelated to the query/u.test(String(allWrong.error)));
check('the hint names the usual causes', /anti-bot|swapped|login wall/iu.test(String(allWrong.hint)),
  JSON.stringify(String(allWrong.hint).slice(0, 70)));
check('both rejected attempts are recorded', allWrong.attempts.length === 2);

const empties = runSearch({ ...base, fetch: fetchFrom({ 'a.example': { results: [] }, 'b.example': { error: 'Failed to connect' } }) });
check('an empty provider falls through to the next one', empties.ok === false && empties.attempts.length === 2);
check('the empty attempt says the page had no results', /no results/u.test(String(empties.attempts[0].error)),
  JSON.stringify(String(empties.attempts[0].error)));
check('the engine error is preserved on its attempt', /Failed to connect/u.test(String(empties.attempts[1].error)));
check('the hint is about the proxy', /proxy/iu.test(String(empties.hint)), JSON.stringify(String(empties.hint).slice(0, 60)));

const aborted = runSearch({ ...base, isAborted: () => true, fetch: fetchFrom({}) });
check('an aborted search returns immediately', aborted.ok === false && /aborted/u.test(String(aborted.error)));
check('an empty query is refused', runSearch({ ...base, query: '   ', fetch: fetchFrom({}) }).ok === false);

console.log('\n7. a search page is read with the settings the report measured');
let captured;
runSearch({ ...base, fetch: options => { captured = options; return { ok: false, url: options.args.url, error: 'stop' }; } });
check('the page is awaited with domcontentloaded', captured.args.wait === 'domcontentloaded', String(captured.args.wait));
check('results come from an expression, not a dump', typeof captured.args.eval === 'string' && captured.args.dump === undefined);
check('the per-attempt deadline is applied', captured.args.timeoutMs === 5000, String(captured.args.timeoutMs));
check('the attempt budget is not the whole-call timeout', captured.args.timeoutMs <= base.attemptTimeoutMs);

// The two shipped adapters bundle this module, so a stale dist would keep the old
// provider order and the old no-relevance-check behaviour in the published package
// while the repository looked fixed. Both are compared byte for byte.
console.log('\n8. both bundled adapters carry this core');
const { readFileSync, existsSync } = await import('node:fs');
for (const plugin of ['codex-moli', 'opencode-moli']) {
  const built = join(REPO, 'plugins', plugin, 'dist', 'lib', 'search.js');
  const current = existsSync(built) && readFileSync(built).equals(readFileSync(join(REPO, 'lib', 'search.js')));
  check(`${plugin} dist carries the current search core`, current, existsSync(built) ? 'run npm run build' : 'missing');
}
const opencodeDist = join(REPO, 'plugins', 'opencode-moli', 'dist', 'index.js');
if (existsSync(opencodeDist)) {
  const pkg = JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf8'));
  const expected = readFileSync(join(REPO, 'plugins', 'opencode-moli', 'src', 'index.js'), 'utf8').replaceAll('__MOLI_VERSION__', pkg.version);
  check('the OpenCode adapter dist is current', readFileSync(opencodeDist, 'utf8') === expected, 'run npm run build:opencode');
  check('the OpenCode adapter reads the shared core', /from '\.\/lib\/search\.js'/u.test(readFileSync(opencodeDist, 'utf8')));
}

console.log(`\nresult: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);