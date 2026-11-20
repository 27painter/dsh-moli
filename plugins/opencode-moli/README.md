# Moli Browser for OpenCode

A native OpenCode V2 plugin that exposes the installed Moli headless browser.
It uses the same browser core as the DSH and Codex adapters in this repository.

## What it registers

- A `websearch` provider named `moli`, backed by Moli. When no
  `websearch.provider` is configured, the plugin makes `moli` the default, so
  OpenCode's built-in `websearch` tool works without an API key.
- Three tools in the `moli` namespace:
  - `moli_fetch` — rendered Markdown, HTML, a semantic tree, a CSS-selector
    match, a JavaScript expression result, or a JSON envelope.
  - `moli_capture` — a PNG screenshot or PDF written to an explicit path. Missing
    parent directories are created.
  - `moli_probe` — inspect the local executable, or install the official Moli
    release with `action: "install"`. It also reports the configured search
    providers and the proxy state.

## Build

From the repository root:

```powershell
npm run build:opencode
```

The build copies the shared `lib/moli.js`, `lib/install.js`, and `lib/search.js` into
`plugins/opencode-moli/dist/lib`, so the package is self-contained.

## Install

Install the published package with OpenCode's package manager:

```powershell
opencode plugin add opencode-moli@3.2.0
```

Equivalently, add the package to `opencode.json` or `opencode.jsonc`:

```json
{
  "plugins": ["opencode-moli@3.2.0"]
}
```

For local development, add the plugin directory instead:

```json
{
  "plugins": ["D:/dsh_plugins/dsh-moli/plugins/opencode-moli"]
}
```

Restart OpenCode if changing a local plugin does not trigger its automatic reload.

## Configuration

The object form passes plugin options:

```json
{
  "plugins": [
    {
      "package": "D:/dsh_plugins/dsh-moli/plugins/opencode-moli",
      "options": {
        "exePath": "C:/Users/me/AppData/Local/Moli/bin/moli.exe",
        "proxy": "http://127.0.0.1:7890",
        "searchUrls": ["https://www.bing.com/search?q={query}"],
        "insecureTls": false
      }
    }
  ]
}
```

| Option | Default | Meaning |
|---|---|---|
| `exePath` | auto-detected | Absolute path to the Moli executable |
| `proxy` | `MOLI_PROXY`, `HTTPS_PROXY`, `HTTP_PROXY`, or `ALL_PROXY` | Forward proxy for every Moli call: fetch, search, capture, and probe |
| `searchUrls` | DuckDuckGo HTML → Baidu → Bing → Brave | Search URL templates containing `{query}` |
| `searchLimit` | `10` | Maximum results per search (capped at 20) |
| `searchAttemptTimeoutMs` | `20000` | Deadline for each fallback provider |
| `defaultTimeoutMs` | `30000` | Default page-readiness timeout |
| `maxChars` | `200000` | Inline text truncation budget |
| `insecureTls` | `true` | Skip TLS host verification. The repository's default assumes a filtering proxy that cannot reach the certificate-revocation responder; set `false` on a healthy network. |
| `installTimeoutMs` | `180000` | Deadline for `moli_probe action="install"` |

Environment variables with the same names as the Codex adapter are also read:
`MOLI_BIN`, `MOLI_PROXY`, `MOLI_SEARCH_URL`, `MOLI_SEARCH_URLS`,
`MOLI_SEARCH_ATTEMPT_TIMEOUT_MS`, `MOLI_TIMEOUT_MS`, `MOLI_MAX_CHARS`,
`MOLI_INSTALL_TIMEOUT_MS`, and `MOLI_INSECURE_TLS`.

## Search behavior

`moli` renders the configured search page with Moli and extracts the ordinary
result links. Providers default to DuckDuckGo HTML → Baidu → Bing → Brave and are
tried in order, waiting for `domcontentloaded`; DuckDuckGo HTML returned ten
results in about 1.0–1.2 seconds in testing. An empty or "no results" page falls
through to the next provider.

Results are also checked for relevance: when none of the titles, URLs, or
snippets contains a query term, the attempt is treated as invalid — a mixed-up
intermediate response or an anti-bot page looks exactly like that — and the next
provider is tried. If every provider fails or is rejected, the call returns
`ok: false` with an `attempts` record per provider instead of unrelated results.

Bing's `u=a1...` redirects and DuckDuckGo's `/l/?uddg=` links are decoded to the
real target URL. Baidu's `link?url=` links still need one more redirect hop.

This is free and keyless, but the result quality and anti-bot behavior are those
of the public search pages, not a paid search API.

## Security

See the repository's [SECURITY.md](https://github.com/27painter/dsh-moli/blob/main/SECURITY.md).
This plugin is independent of OpenCode and Moli/Lexmount.
