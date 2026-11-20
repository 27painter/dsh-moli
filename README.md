# dsh-moli

[![npm version](https://img.shields.io/npm/v/dsh-moli)](https://www.npmjs.com/package/dsh-moli)
[![license](https://img.shields.io/npm/l/dsh-moli)](LICENSE)
[![Cross-agent: DSH | Codex | OpenCode](https://img.shields.io/badge/cross--agent-DSH_%7C_Codex_%7C_OpenCode-6f42c1?style=for-the-badge)](#install)
[![listed in awesome-dsh-plugin](https://img.shields.io/badge/awesome--dsh--plugin-listed-3964fe)](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin)
[![HOL Trust Score](https://img.shields.io/endpoint?url=https%3A%2F%2Fhol.org%2Fapi%2Fregistry%2Fbadges%2Fplugin%3Fslug%3D27painter%252Fmoli%26metric%3Dtrust%26style%3Dfor-the-badge)](https://hol.org/registry/plugins/27painter%2Fmoli)
[![listed in Awesome Codex Plugins](https://img.shields.io/badge/Awesome_Codex_Plugins-listed-3964fe)](https://github.com/hashgraph-online/awesome-codex-plugins)

A local browser bridge for **DeepSeek Harness (DSH)**, **Codex**, and **OpenCode**.
It wraps [Moli](https://github.com/lexmount/moli), a Rust headless browser for AI agents, to fetch
JavaScript-rendered pages, search the web, and capture screenshots or PDFs.

English | [中文](README.zh.md)

## Why use it

Use this plugin when `web_fetch`, `curl`, or a plain HTTP request is not enough:

- client-rendered applications and documentation;
- pages behind cookies, consent screens, or a session;
- text hidden behind lazy loading or a `scroll` event;
- screenshots, PDFs, or one value extracted from a large page.

For plain articles, APIs, and static HTML, the host's normal `web_fetch` is lighter and faster.

| Adapter | Adds |
|---|---|
| DSH | `moli_fetch`, `moli_probe` |
| Codex | `moli_search`, `moli_fetch`, `moli_capture`, `moli_probe` |
| OpenCode | keyless `websearch` provider plus `moli_fetch`, `moli_capture`, `moli_probe` |

All three adapters use the same browser core and the installed `moli` engine.

## Install

Requirements: Node.js `>=20.12` and a Moli engine. The engine is installed separately because it is a
platform-specific native binary and is released by the upstream Moli project.

### 1. Install the Moli engine

The easiest route is the plugin's own probe:

```text
moli_probe action=install
```

Or use Moli's official installer:

```powershell
# Windows
powershell -ExecutionPolicy ByPass -c "irm https://github.com/lexmount/moli/releases/latest/download/moli-installer.ps1 | iex"
```

```sh
# Linux / macOS
curl --proto '=https' --tlsv1.2 -fsSL https://github.com/lexmount/moli/releases/latest/download/moli-installer.sh | sh
```

If the binary is in a nonstandard location, set `MOLI_BIN` for Codex/OpenCode or `exePath` in the DSH
configuration.

### 2. Install an adapter

#### DSH

```powershell
dsh plugin --profile web add dsh-moli
```

For the desktop profile, use the in-app **Plugins → Add plugin** page. The CLI refuses to modify the
Electron-owned desktop profile directly.

#### Codex

```powershell
codex plugin marketplace add 27painter/dsh-moli --ref main
codex plugin add moli@27painter-codex
```

Start a new Codex conversation after installation. Codex has no direct npm plugin install route;
plugins are resolved through a local or Git marketplace.

Codex plugin: [Awesome Codex Plugins](https://github.com/hashgraph-online/awesome-codex-plugins) ·
[HOL registry](https://hol.org/registry/plugins/27painter%2Fmoli)

#### OpenCode

```powershell
opencode plugin add opencode-moli@3.1.0
```

Or add it to `opencode.json` / `opencode.jsonc`:

```json
{
  "plugins": ["opencode-moli@3.1.0"]
}
```

OpenCode-specific options and environment variables are documented in
[`plugins/opencode-moli/README.md`](plugins/opencode-moli/README.md).

## Quick start

```text
moli_probe
moli_fetch url=https://example.com dump=markdown
moli_fetch url=https://example.com selector="main"
moli_fetch url=https://example.com dump=screenshot writeTo=/absolute/path/page.png
```

In Codex, `moli_search` also provides browser-backed search:

```text
moli_search query="current Rust release"
```

In OpenCode, the plugin registers `moli` as a `websearch` provider, so the built-in `websearch` tool
works without a separate search API key.

## Usage

`moli_fetch` supports:

```text
url, dump, writeTo, selector, eval, scroll, wait,
waitSelector, waitScript, waitResponseUrl, waitResponseJson, delayMs,
timeoutMs, maxChars, headers, userAgent, layout, scrollbars, noJs,
noCss, resources, withFrames, insecureTls, failOnHttpError,
profileDir, cookieFile, proxy
```

Common examples:

```text
moli_fetch url=https://example.com dump=markdown
moli_fetch url=https://example.com dump=semantic_tree_text
moli_fetch url=https://example.com eval="document.title"
moli_fetch url=https://example.com selector=".video-card"
moli_fetch url=https://example.com/feed selector="h2" scroll=2000
moli_fetch url=https://example.com dump=pdf writeTo=/absolute/path/page.pdf
moli_fetch url=https://example.com/missing failOnHttpError=true
```

### Use `selector` for lists

`selector` returns only the matched elements instead of sending the whole page to the model:

```text
moli_fetch url=https://example.com/feed selector=".video-card"
```

It is usually the cheapest and most accurate way to read search results, feeds, tables, and product
lists. A selector with no match is an error. `selector` cannot be combined with `dump` or `eval`.

### Wait for the actual response

Prefer a specific readiness signal over a fixed delay:

```text
moli_fetch url=https://example.com/feed waitResponseUrl="/api/feed"
moli_fetch url=https://example.com/feed waitResponseJson="data.list.0.id=42"
moli_fetch url=https://example.com/app waitScript="window.appReady === true"
```

`scroll` runs before capture for lazy-loaded content. `eval` without `dump` returns the expression
value; using both is allowed, but the value is discarded and the result reports `evalDiscarded`.

## Configuration

DSH configuration is optional and lives in the profile patch layer:

```yaml
- insert:
    - id: dsh-moli
      name: dsh-moli
      config:
        exePath: 'C:\Users\me\AppData\Local\Moli\bin\moli.exe'
        defaultTimeoutMs: 30000
        maxChars: 200000
        proxy: 'http://127.0.0.1:7890'
        insecureTls: true
```

The same fields are editable from the DSH plugin settings page.

Codex reads these environment variables:

| Variable | Default |
|---|---|
| `MOLI_BIN` | auto-detected engine path |
| `MOLI_PROXY` | existing `HTTPS_PROXY`, `HTTP_PROXY`, or `ALL_PROXY` |
| `MOLI_SEARCH_URLS` | Bing → DuckDuckGo HTML → Brave |
| `MOLI_TIMEOUT_MS` | `30000` |
| `MOLI_MAX_CHARS` | `200000` |
| `MOLI_INSECURE_TLS` | `0` |

To make Moli the normal search path in Codex, place this before the first TOML table:

```toml
web_search = "disabled"

[plugins."moli@27painter-codex"]
enabled = true
```

OpenCode accepts equivalent options in its plugin entry and reads the same `MOLI_*` environment
variables. See [`plugins/opencode-moli/README.md`](plugins/opencode-moli/README.md).

## Platform support

| Platform | Status |
|---|---|
| Windows | Verified by the maintainer |
| Linux | Contributed and verified on Ubuntu 24.04 by [@nd002723](https://github.com/nd002723) |
| macOS | Engine-backed CI coverage on Apple Silicon |

The plugin searches the standard Moli installation paths and `$PATH`. Set `MOLI_BIN` or `exePath`
when the engine is installed elsewhere.

## Limitations

- Moli is not bundled with any npm package.
- Moli's CDP/WebDriver server and session-import commands are not exposed.
- A normal fetch cannot be cancelled mid-flight; engine installation runs asynchronously.
- `insecureTls` defaults to `true` for filtering proxies. Set it to `false` on a healthy network.
- Use `failOnHttpError=true` when a 4xx/5xx response must be reported as a failure.
- DSH sandbox HTTPS may require `danger-full-access` on affected Windows configurations.
- `writeTo` artifact calls are serialized.

## Development

```powershell
npm install
npm run build:codex
npm run verify:codex
npm run build:opencode
node verify/empty-verify.mjs
```

The main CI matrix runs on Windows, Linux, and macOS. Engine-dependent suites download a real Moli
release. Test scripts live in [`verify/`](verify/), and GitHub Actions is the source of truth for the
full suite.

## Security

Local execution, network, proxy, cookie, TLS, and installer boundaries are documented in
[SECURITY.md](SECURITY.md).

## Versions

### 3.1.0

Adds the native OpenCode V2 adapter, including keyless websearch, `moli_fetch`, `moli_capture`, and
`moli_probe`. DSH and Codex tool contracts are unchanged.

<details>
<summary>Earlier releases</summary>

- **2.1.1** — Codex directory metadata, security files, pinned Actions, and HOL scanner workflow.
- **2.1.0** — Codex MCP adapter with search, fetch, capture, and probe tools.
- **1.1.11 / 1.1.12** — deprecated; use a maintained release.

</details>

## License

MIT. See [LICENSE](LICENSE). Moli is also MIT-licensed; this project is an independent integration
and is not affiliated with or endorsed by the Moli project.
