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
  - `moli_capture` — a PNG screenshot or PDF written to an explicit path.
  - `moli_probe` — inspect the local executable, or install the official Moli
    release with `action: "install"`.

## Build

From the repository root:

```powershell
npm run build:opencode
```

The build copies the shared `lib/moli.js` and `lib/install.js` into
`plugins/opencode-moli/dist/lib`, so the package is self-contained.

## Install

Add the plugin directory to `opencode.json` or `opencode.jsonc`:

```json
{
  "plugins": ["D:/dsh_plugins/dsh-moli/plugins/opencode-moli"]
}
```

Restart OpenCode after changing the plugin list. Once the package is published,
the entry can be the package name instead of a path.

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
| `proxy` | `MOLI_PROXY`, `HTTPS_PROXY`, `HTTP_PROXY`, or `ALL_PROXY` | Forward proxy for search and fetch calls |
| `searchUrls` | Bing → DuckDuckGo HTML → Brave | Search URL templates containing `{query}` |
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
result links. It tries each provider until one returns at least one structured
result; an empty or "no results" page falls through to the next provider. This is
free and keyless, but the result quality and anti-bot behavior are those of the
public search pages, not a paid search API.

## Security

See the repository's [SECURITY.md](https://github.com/27painter/dsh-moli/blob/main/SECURITY.md).
This plugin is independent of OpenCode and Moli/Lexmount.
