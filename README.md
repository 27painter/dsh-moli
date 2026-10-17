# dsh-moli

[![npm version](https://img.shields.io/npm/v/dsh-moli)](https://www.npmjs.com/package/dsh-moli)
[![license](https://img.shields.io/npm/l/dsh-moli)](LICENSE)

**Two tools that let a DeepSeek Harness agent drive a real headless browser.** They wrap
[Moli](https://github.com/lexmount/moli) — a Rust headless browser built for AI agents — so an agent can
read pages that only exist after JavaScript runs, and can produce pictures of them.

English | [中文](README.zh.md)

## What it does, and when you want it

A plain HTTP fetch returns the HTML the server sent. That is enough for articles, docs and APIs, and
DSH already covers it with `web_fetch`. It is not enough for anything a browser has to build:

- **Single-page apps** — a client-rendered news site, dashboard or docs site. The response is an empty
  shell; the content appears only after scripts run.
- **Logins and consent walls** — a page that needs a session or cookie before it shows anything.
- **Pictures** — a screenshot to see what a page looks like, or a PDF to keep.
- **One value from deep inside a page** — a price, a count, a title, read with a selector instead of
  pulling the whole document.

For those jobs this plugin gives the agent two tools:

| Tool | What it does |
|---|---|
| `moli_fetch` | Renders a URL and returns Markdown, HTML, a semantic tree, or a JSON envelope carrying the HTTP status; evaluates a JavaScript expression; writes a PNG screenshot or a PDF |
| `moli_probe` | Reports whether the engine is installed, which version, and whether HTTPS works — and installs Moli when it is missing |

The practical question is whether the agent needs the page as a **browser** would see it. If a plain
fetch already returns the text you want, `web_fetch` is lighter and faster.

```
  agent ──moli_fetch──▶ dsh-moli plugin ──spawns──▶ moli.exe
                              ▲                         │
                              │                    renders the page,
                              │                    runs its JavaScript
                              │                         │
                              └──markdown / json / png / pdf◀┘
```

## Install

Two routes. Both install the same plugin; pick by what your network reaches.

**Route 1 — from npm (recommended).** Resolves through the npm registry, so it works where GitHub is
slow or blocked, and DSH's install dialog can fall back to a regional mirror:

```powershell
dsh plugin --profile web add dsh-moli
```

**Route 2 — straight from the repository.** Tracks the source directly; needs GitHub to be reachable:

```powershell
dsh plugin --profile web add github:27painter/dsh-moli
```

> [!IMPORTANT]
> **The npm package is the plugin only — it does not contain the Moli engine.**
>
> The npm tarball is 26 kB: eight JavaScript and text files. `moli.exe` is a separate ~101 MB compiled
> Rust binary, built and released by the Moli project on its own schedule.
>
> **Why it cannot be bundled:**
>
> - **Size.** The engine is roughly 4,000× the plugin. Every install and every plugin update would
>   carry a browser.
> - **Ownership.** Moli is `lexmount/moli` under its own MIT copyright. Redistributing its binary
>   through this package would mean re-publishing someone else's artifact as our own.
> - **Platforms.** The engine ships per OS and per architecture — Windows/Linux/macOS × x64/arm64.
>   Bundling would pin one build into every user's install.
> - **Versions.** The plugin must work with whatever Moli version a user has, including Moli releases
>   that appear after the plugin was published. Bundling would lock the pair together.
>
> **There is no npm package for the engine either.** The registry names `moli` and `moli-cli` belong to
> unrelated projects, and `@lexmount/moli` does not exist. Moli ships as prebuilt binaries on
> [GitHub Releases](https://github.com/lexmount/moli/releases/latest) — do not install the engine by
> guessing a package name.

## The two situations after installing

The two download routes above install the same thing. What differs is whether Moli is already on the
machine — and that decides whether you are finished or have one more step.

### Situation A — Moli is already installed: nothing else to do

The plugin discovers `moli.exe` on its own and both tools work immediately. Just restart DSH and
confirm:

```
moli_probe
```

If the reported version looks right, you are done.

### Situation B — Moli is not installed yet: fetch the engine too

`moli_fetch` will keep reporting a missing engine until you install one. Do that with either of:

```
moli_probe action=install          # let the plugin fetch it
```

```powershell
# or run Moli's own installer yourself
powershell -ExecutionPolicy ByPass -c "irm https://github.com/lexmount/moli/releases/latest/download/moli-installer.ps1 | iex"
```

Then confirm with `moli_probe` and fetch a page:

```
moli_probe
moli_fetch url=https://example.com dump=markdown
```

### Getting the Moli engine

`moli_probe` reports whether the engine is present. If it is not, pick one of:

**1. Let the plugin install it** — tries several download routes and reports a SHA256 of what it ran.
   The whole run is asynchronous (the host keeps serving), and a configured `proxy` is passed to both
   the download routes and the installer's own engine download:

```
moli_probe action=install
```

**2. Official one-line installer** (Moli's own documented commands):

```powershell
# Windows
powershell -ExecutionPolicy ByPass -c "irm https://github.com/lexmount/moli/releases/latest/download/moli-installer.ps1 | iex"
```

```sh
# Linux / macOS
curl --proto '=https' --tlsv1.2 -fsSL https://github.com/lexmount/moli/releases/latest/download/moli-installer.sh | sh
```

**3. Direct binary,** if you would rather not run an installer:

```powershell
# pick the asset matching your architecture from the releases page
curl.exe -L -o moli.zip https://github.com/lexmount/moli/releases/latest/download/moli-x86_64-pc-windows-msvc.zip
Expand-Archive moli.zip -DestinationPath "$env:LOCALAPPDATA\Moli" -Force
```

Those `releases/latest/download/...` URLs always resolve to the newest release, so they stay valid
without pinning a version.

After any of them, point the plugin at the result if it landed somewhere unusual:

```yaml
config:
  exePath: 'C:\path\to\moli.exe'
```

#### Verifying the download

Moli's README documents no checksum or signature, and the installer publishes no checksum file. What
does exist is GitHub's own per-asset `sha256` digest, readable from the release API:

```powershell
(irm https://api.github.com/repos/lexmount/moli/releases/latest).assets | Select-Object name, digest
```

For `v1.1.17` that reports, among others:

```
moli-installer.ps1                2,020  sha256:e002f7a6c174d78ae6ed7289aca9f5d3a62ab0b1f6e588606a80c0cb5d37964d
moli-x86_64-pc-windows-msvc.zip  43.8 MB  sha256:5247309837b6eaf6e73bfa18f2a8d8d90473b9e2fe5cfcaaef57d7eee9b074c4
```

Compare it against the file you downloaded:

```powershell
(Get-FileHash .\moli-installer.ps1 -Algorithm SHA256).Hash.ToLower()
```

The plugin follows the same discipline: `moli_probe action=install` reports the SHA256 of the bytes it
ran, and `expectedSha256` turns that report into an enforced gate. It does not invent a trusted
default, because a digest only means something when compared against the release page's own value.

This is a checked property rather than a claim: downloading `v1.1.17`'s installer through the plugin's
own `downloadInstaller` reproduced `e002f7a6…964d` exactly — the digest GitHub publishes — and
re-hashing the file from disk matched as well.

### Installing into a desktop profile

`dsh plugin --profile desktop …` is refused — the desktop profile belongs to the Electron app. Either
edit its `package.json` directly, or use the in-app plugin page (sidebar → **Plugins** → **Add
plugin**), which installs through the same pnpm path.

A profile plugin needs both halves: a dependency edge (`dependencies`) and a
`dsh.profile.bundles` entry. One without the other leaves the plugin invisible to the loader. From a
local checkout the four steps are:

1. Put this directory anywhere, e.g. `D:\dsh_plugins\dsh-moli`.
2. Add both entries to the profile's `package.json`:
   - `dependencies`: `"dsh-moli": "link:D:/dsh_plugins/dsh-moli"`
   - `dsh.profile.bundles`: `"dsh-moli"`
3. Run `pnpm install` in the profile directory (creates `node_modules/dsh-moli`).
4. Restart DSH.

An unresolvable bundle is **skipped silently** apart from one stderr line
(`skipping profile bundle …`). If the tools never appear, that line is the first thing to look for.

## Usage

`moli_fetch` parameters: `url` (required), `dump`, `writeTo`, `selector`, `eval`, `scroll`, `wait`,
`waitSelector`, `waitScript`, `waitResponseUrl`, `waitResponseJson`, `delayMs`, `timeoutMs`,
`maxChars`, `headers`, `userAgent`, `layout`, `scrollbars`, `noJs`, `noCss`, `resources`,
`withFrames`, `insecureTls`, `failOnHttpError`, `profileDir`, `cookieFile`, `proxy`.

```
moli_fetch url=https://example.com dump=markdown             # token-efficient text
moli_fetch url=https://example.com dump=semantic_tree_text    # nodes with backend ids
moli_fetch url=https://example.com eval="document.title"      # one computed value
moli_fetch url=https://example.com selector=".video-card"     # one container, not the page
moli_fetch url=https://example.com dump=screenshot writeTo=/abs/path/a.png
moli_fetch url=https://example.com dump=pdf        writeTo=/abs/path/a.pdf
moli_fetch url=https://example.com dump=markdown scroll=800   # trigger lazy loading first
```

Screenshot and PDF dumps need `writeTo`; the bytes are written verbatim rather than printed.

### `selector` — read one container, not the page

A listing page is mostly noise if you only want the items. `selector` returns the text
of the elements a CSS selector matches, which on a node-dense feed measured **1,829
characters against 95,605** for the same page as Markdown.

```
moli_fetch url=https://example.com/feed selector=".video-card"
moli_fetch url=https://example.com/feed selector="h2" scroll=2000    # scroll first, then read
```

All matches are joined with newlines and the result reports how many there were:
"matched 48 element(s)" is the difference between a complete read and a partial one,
and it is the only signal you get that the selector was too broad or too narrow.

Two cases are deliberately errors rather than empty answers, because the engine
cannot tell an empty selection from a page with no text — an expression returning
`""` exits 0 with a blank line:

- **nothing matched** — `ok: false`, "no element matches". A selector that is not on
  the page is almost always a spelling mistake or a page that has not loaded yet.
- **matched, but no text** — `ok: false`, "match but none of them has any text", which
  is what an icon or an image container gives you. Use `eval` if you need attributes.

`selector` cannot be combined with `dump` or `eval`: a selector returns one
container's text, a dump returns the whole page, and only one expression value can be
returned — so one of them could only be silently ignored, which is the failure mode
this plugin keeps having to fix.

### `scroll` — reach what only appears on a scroll

The engine serializes the whole document, so a plain fetch already contains everything the DOM holds.
What it cannot contain is content that does not exist yet: a list that loads on the first `scroll`
event, an `IntersectionObserver` that fires on entry, an image swapped in when it nears the viewport.
`scroll` runs the scroll before the capture, so those handlers fire first.

```
moli_fetch url=https://example.com/feed dump=markdown scroll=600
moli_fetch url=https://example.com/feed dump=markdown scroll=bottom
moli_fetch url=https://example.com/feed dump=markdown scroll=-400    # back up
```

Measured on a page whose `scroll` handler fills a slot: without `scroll` the dump says
`STILL-EMPTY`, with `scroll=1000` it says `LAZY-CONTENT-1000`. It also moves the screenshot, so a
scrolled `dump=screenshot` shows that part of the page.

`scroll` is a side effect, so it composes and stands alone:

```
moli_fetch url=... dump=markdown scroll=600      # scroll, then dump the page
moli_fetch url=... eval="document.title" scroll=600   # scroll, then read a value
moli_fetch url=... scroll=600                    # just scroll; you still get the page
```

The last form is worth spelling out because it was broken. The scroll runs in the engine's own
pre-capture evaluation, and without `dump` the engine prints whatever that evaluation returns — so an
earlier version that returned the scroll position made this call answer `600` instead of the document,
while the identical call without `scroll` returned 1,989 characters of HTML. A scroll reports nothing
now; it only happens.

### `eval` with `dump` — the expression value is dropped

The engine documents this and it is kept, because using an expression to change a page before
capturing it is a real pattern. What is not acceptable is that it used to look like a clean answer:
`eval='JSON.stringify({probe:1})'` with `dump=markdown` returned 900 characters of Markdown, reported
`ok: true`, and said nothing. The result now carries `evalDiscarded: true` and a note, and the rendered
output leads with the warning rather than burying it under the body.

If you want the expression's value, pass `eval` without `dump`.

### `failOnHttpError` — stop reading an error page as content

By default a 404 is returned like any other page, so a failed fetch looks successful. Setting
`failOnHttpError` turns a final status of 400 or above into `ok: false` with the status named — and
**keeps the body**, because an error page is often the thing you need to read.

```
moli_fetch url=https://example.com/nope dump=markdown failOnHttpError=true
```

| | default | `failOnHttpError: true` |
|---|---|---|
| a 404 | `ok: true`, the error page as content | `ok: false`, `status: 404`, body still returned |
| a screenshot of a 404 | written as a normal image | still written, and reported as a failure |

It is off by default so existing calls keep their behaviour. A JSON dump already reported the status
on its own; markdown and HTML dumps did not, and that is the gap this closes.

### Waiting for what the page actually fetches

`wait: "networkidle"` plus `delayMs` is a guess about how long a list takes to arrive. These wait for
the request itself:

```
# the response that carries the data
moli_fetch url=https://example.com/feed dump=markdown waitResponseUrl="/api/feed"

# the payload, when the URL is not distinctive
moli_fetch url=https://example.com/feed dump=markdown waitResponseJson="data.list.0.id=42"

# the page's own idea of readiness
moli_fetch url=https://example.com/app dump=markdown waitScript="window.appReady === true"
```

`waitResponseJson` takes `PATH=VALUE`, where `PATH` addresses the field and `VALUE` is compared
literally. Use these when a fixed delay either wastes time or reads the page too early.

## Relationship to Moli's own agent skills

Moli ships official agent skills in its repository — [`moli-webfetch`](https://github.com/lexmount/moli/tree/main/skills/moli-webfetch),
[`moli-websearch`](https://github.com/lexmount/moli/tree/main/skills/moli-websearch), and
[`moli-cdp-server`](https://github.com/lexmount/moli/tree/main/skills/moli-cdp-server) — and their
README's quick start is to have an agent install them. If your agent loads skills, the simplest path
is to point it at those; they are maintained upstream and cover web search and a CDP server too.

This plugin exists because it is a different trade-off, not a replacement:

- **Always-on tool schemas instead of an on-demand skill.** The tools are registered at Host startup,
  so the model sees them every turn with no discovery step.
- **DSH-specific failure handling.** The three traps below (sandbox pipe capture, UTF-16 mangling of
  binary output, bare-specifier resolution for a `link:`ed plugin) plus sandbox/revocation/proxy
  classification are solved here, because they are DSH-on-Windows problems.
- **Smaller surface.** Only `fetch` is wrapped; the official skills also cover web search and the CDP
  server, which this plugin does not.

Both can coexist: install the skills if you want upstream coverage, keep this plugin if you want the
capabilities always visible to the model.

## Three design points

1. **Output goes through file descriptors, never pipes.** Under DSH's Windows sandbox a child
   process cannot open an inherited named pipe, so `spawnSync(..., { stdio: 'pipe' })` returns
   `status=null` and zero bytes. Every run redirects stdout/stderr to real files and reads them back.
2. **Binary output is copied byte for byte.** PowerShell's `>` operator re-encodes a native
   program's output as UTF-16, inserting a `00` after every byte, which corrupts a screenshot.
   Bytes here are written verbatim, so the PNG signature stays `89504e470d0a1a0a`.
3. **One optional external dependency.** A profile plugin is loaded from its real path on disk (a `link:`
   dependency stays a symlink target), so a bare specifier such as `@deepseek-ai/schemastery`
   resolves against the plugin directory instead of the profile's `node_modules`. The import is
   therefore guarded: without schemastery (a `link:` install) the settings form does not appear and
   the plugin degrades to plain patch-layer configuration, while `moli_fetch` and `moli_probe` keep
   registering. With it (a normal npm install, which brings the dependency along) the settings page
   is available.

## Platform support

Works on **Windows, Linux and macOS** (x64 / arm64).

> **Linux and macOS support was contributed by [@nd002723](https://github.com/nd002723)** in
> [PR #1](https://github.com/27painter/dsh-moli/pull/1): engine discovery in the standard POSIX
> locations, the `sh` installer route, and the per-platform gating of the PowerShell paths.

| Platform | Status |
|---|---|
| **Windows** | Verified by the maintainer |
| **Linux** | Verified by the contributor, not the maintainer: Ubuntu 24.04 LTS, Node v24.21.0, Moli 1.1.17 — including the async install path, proxy injection, and a `strace`-recorded end-to-end fetch |
| **macOS** | Implemented, not yet verified on a real host |

- **Windows** — the engine is located at the official installer paths (`%LOCALAPPDATA%\Moli\bin\moli.exe`,
  `%USERPROFILE%\.local\bin\moli.exe`) with a recursive scan of `%LOCALAPPDATA%\Moli` as a fallback.
  `moli_probe action=install` runs the official PowerShell installer.
- **Linux / macOS** — the engine is found in the standard locations (`~/.local/bin/moli`,
  `~/.local/share/moli/bin/moli`, `~/.local/share/moli/moli`, `~/.moli/bin/moli`) and on `$PATH`.
  `moli_probe action=install` runs the official `moli-installer.sh` via `sh`.

**Installing never blocks the DSH host.** Both the installer download and the execution of the
official installer spawn asynchronously with a timeout that escalates from SIGTERM to SIGKILL, and
an interrupted turn aborts the child immediately — the host keeps serving while Moli's installer
does its work. A `strace -e trace=connect` run against a real install recorded every connection
going through the configured proxy port and none to the upstream host, and a fixture installer
confirmed the proxy arrives in the child's environment.

The configured `proxy` feeds **both** phases: the plugin's own download routes (`curl --proxy`, and
`-Proxy` on PowerShell's `Invoke-WebRequest`), and the official installer's internal engine download
— on Windows through a `DefaultWebProxy` prelude (PowerShell's `Invoke-WebRequest` ignores proxy
environment variables), on POSIX through the standard `HTTPS_PROXY`/`HTTP_PROXY`/`ALL_PROXY`
variables the installer's `curl` reads. A proxy carrying credentials sets them explicitly.

On Linux, `moli_probe` discovered `~/.local/bin/moli` unaided, and `moli_fetch` rendered a
region-gated storefront end to end — through a local forward proxy, with a Netscape `cookieFile` —
returning a 500+ KB page whose final URL carried the cookie-driven query parameters. That run
exercised the proxy download route as well as the engine paths.

## Configuration

Override any field under the plugin's `config` entry in the profile patch layer. All are optional.
The same fields are also editable from the **Moli 安装与抓取** settings section on the plugin's page in
the Plugins manager (a `plugins.bundle.config` form registered by the browser half).

```yaml
- insert:
    - id: dsh-moli
      name: dsh-moli
      config:
        exePath: 'C:\Users\me\AppData\Local\Moli\bin\moli.exe'  # default: auto-detect
        defaultTimeoutMs: 30000                                  # per-fetch readiness deadline
        maxChars: 200000                                         # inline text truncation
        proxy: 'http://127.0.0.1:7890'                           # forward proxy for moli, downloads, and the installer's engine download
        insecureTls: true                                        # see the TLS notes below
```

The plugin-level `proxy` above is the default; `moli_fetch` also takes a `proxy` argument, so a single
call can route through a different proxy without changing the profile. A loopback URL always bypasses
whichever proxy is in effect.

Without `exePath`, the plugin probes `exePath` → `MOLI_BIN` → `%LOCALAPPDATA%\Moli\bin\moli.exe` →
`%USERPROFILE%\.local\bin\moli.exe`, then scans inside `%LOCALAPPDATA%\Moli` for a `moli.exe`, so an
installation under a versioned subdirectory is still found.

### Engine lifecycle from the settings page

The settings section also carries an **engine** row that detects the installed engine and lets you
install or uninstall it without touching the profile:

- **state** — `engineState` is `installed` (with `engineVersion`), `missing`, or a short error text.
- **install** — the form writes `engineAction: "install"`; the host downloads and runs the official
  installer asynchronously, then reports the outcome back through `engineState` / `engineVersion`.
- **uninstall** — `engineAction: "uninstall"` removes the engine. On Windows only the installer-owned
  `%LOCALAPPDATA%\Moli` tree is deleted; without one, nothing is touched. On POSIX the located binary
  is removed and the now-empty install directories are pruned.

These three fields (`engineAction`, `engineState`, `engineVersion`) are part of the live Config schema;
`engineAction` is a `none`/`install`/`uninstall` union. They are meant to be driven by the settings
form, so prefer editing the four fields above for routine configuration.

## Known limitations

- **macOS is untested, and Linux was tested by the contributor rather than the maintainer.** The
  maintainer is a student with no macOS or Linux machine, so Linux was verified independently by
  [@nd002723](https://github.com/nd002723) on Ubuntu 24.04 (see [Platform support](#platform-support));
  macOS has not been run on a real host at all. **If something fails on either, please open an
  [issue](https://github.com/27painter/dsh-moli/issues) with the error output** — that is the only way
  these paths get fixed.
- **Moli itself is not bundled.** Install it separately or let `moli_probe action=install` fetch it.
- **Only `fetch` is wrapped.** `moli serve` (CDP/WebDriver server) and `moli import` (session
  import) are not exposed as tools yet.
- **No per-call cancellation for fetches.** The engine runs synchronously for a fetch, so an
  interrupted turn cannot abort it mid-flight; a call already in progress finishes and its artifact
  is written. `moli_probe action=install` is the exception — it is asynchronous and aborts the child
  immediately on an interrupted turn.
- **HTTP error status is only visible for `dump: json`.** That is the only dump format carrying the
  status field. With `markdown` or `html` an error page is returned as content.
- **`writeTo` calls are serialized.** They report as unsafe to parallelize, so two artifact writes
  never interleave.
- **`insecureTls` defaults to `true`.** Behind a filtering proxy the certificate-revocation
  responder is often unreachable, and Schannel then fails with
  `CRYPT_E_REVOCATION_OFFLINE (0x80092013)` on hosts like GitHub. The default passes moli's
  `--insecure-disable-tls-host-verification`. Set `insecureTls: false` on networks where revocation
  checks work, or per call with `insecureTls: false`.
- **Sandbox interaction.** Under DSH's default file sandbox, a subprocess runs at low integrity and
  Schannel cannot acquire client credentials, so HTTPS fails with `SEC_E_NO_CREDENTIALS`. Plain
  HTTP still works and the failure is reported structurally (`sandboxTlsBlock: true`) with the
  retry path; passing `sandbox_permissions: "danger-full-access"` for that call resolves it.
- **Host reachability varies on some networks.** Observed on the development machine: `curl`-based
  clients (Moli) timed out on `github.com` while `git` over HTTPS and the system browser reached it
  in seconds, and `api.github.com` worked where `github.com` did not — at the same moment. Treat a
  timeout as possibly transient: retry, or set `proxy`. Because a bare timeout is ambiguous, it is
  reported as `possiblyUnreachable` rather than a verdict. The install action's multi-route fallback
  and the manual commands above exist for exactly this case.

## Verification

Eight suites live in [`verify/`](verify/), and all are runnable against a working tree:

- `config-verify.mjs` checks the settings surface and engine lifecycle added by the plugin's browser
  half: the volatile `Config` schema (every declared field, `engineAction` as a `none`/`install`/
  `uninstall` union), `apply` reading both a plain config and a volatile `.get()` reference, the
  `settings/document-updated` wiring, `uninstallMoli` (platform-aware: POSIX removes the located
  binary, Windows removes only the installer-owned `%LOCALAPPDATA%\Moli` tree), and the client.js
  shape (`plugins.bundle.config` registration, zh/en dictionaries, raw `true`/`false` select labels).
- `schema-verify.mjs` checks the tool definitions with the registry's own validator, including
  controls that assert the two invalid schema shapes still fail.
- `install-verify.mjs` drives the install pipeline against a loopback HTTP server: route ordering,
  the SHA256 of served bytes, refusal to execute on a checksum mismatch, actual execution when the
  digest matches, and the all-routes-failed diagnostic.
- `linux-verify.mjs` (POSIX hosts) asserts the proxy-helper functions, then against a real install
  proves the two guarantees of the async rewrite: the installer child actually receives the proxy
  through its environment (`HTTPS_PROXY` captured by a fixture installer), and the host event loop
  stays live while a slow installer runs — the acceptance criterion for the async path.
- `win-verify.mjs` (Windows hosts) runs the same pure assertions, then executes the `DefaultWebProxy`
  prelude in a real `powershell.exe` and inspects the proxy object and credentials it set, exercises
  the Windows download routes, and runs `installMoli` end to end.
- `empty-verify.mjs` asserts, against three compiled stub engines, that a fetch which exits 0 with no
  output is a successful empty result rather than an error, that a non-zero exit still fails, and that
  a complaint on stderr with no stdout is not mistaken for an empty page.
- `report-verify.mjs` guards the findings from a usage report: `eval` documents that pairing it with
  `dump` discards its value, an expression that throws is classified as such instead of being blamed
  on the installation, truncation keeps the tail as well as the head, `proxy` is a per-call parameter,
  and `moli_probe` states which process its `httpsOk` describes.
- `scroll-verify.mjs` checks the expression builder without an engine (pixels, negatives, `top`,
  `bottom`, nonsense rejected, the caller's `eval` value preserved) and then, when an engine is
  present, fetches a page whose `scroll` handler fills a slot and asserts the content appears with
  `scroll` and the placeholder appears without it — a property of the output, not of an internal call.
- `selector-verify.mjs` covers the two silent-wrong-answer cases a container read invites: a selector
  matching nothing is an error rather than empty content, and a selector matching several elements
  reports the count and joins them. It also asserts that the selector is quoted as data rather than
  spliced into the expression, that `selector` with `dump` or `eval` is refused instead of one of them
  being ignored, and that it composes with `scroll`.
- `http-verify.mjs` asserts the parameter-to-flag mapping directly, because a parameter that never
  reaches the engine is indistinguishable from a feature that does not work. It then fetches a 404 and
  checks that `failOnHttpError` reports it while keeping the body, that a healthy page is unaffected,
  and that a screenshot of an error page is still written as a valid PNG rather than decoded as text.
  It also covers the two silent-answer cases: `eval` with `dump` is flagged `evalDiscarded` and the
  warning renders first, and `scroll` alone returns the document rather than the scroll offset.
  The end-to-end half needs an HTTP error from a real server: loopback is unreachable from inside this
  sandbox — `curl.exe` times out on `127.0.0.1` while the Node host reaches it — so it uses a path
  under `example.com` and skips when the network is away.

`.github/workflows/verify.yml` runs `schema-verify`, `empty-verify` and `scroll-verify` on Linux,
Windows and macOS (they need no engine and no network) and attempts the engine-dependent suites on
Linux and Windows, reporting a missing engine as a skip rather than a failure.

`report-verify.mjs` is deliberately **not** in CI. Three of its checks fetch `example.com` and one
fetches a specific forum thread, so it needs the open internet — and on a host whose traffic goes
through a proxy, that proxy too. Useful where a network is available, but a suite that goes red
because a website changed is worse than no suite, so it stays a local check. If you run it and see
failures in sections 4–6 while sections 1–3 pass, suspect the network before the code.

### Prerequisites for the suites

The plugin has one optional runtime dependency — [`@deepseek-ai/schemastery`](https://www.npmjs.com/package/@deepseek-ai/schemastery) — used by the live `Config` schema that registers the settings namespace (optional because the import is guarded, so a `link:` install without it still loads and registers the tools). Suites that import the plugin (`config-verify`, `schema-verify`, `empty-verify`, `report-verify`, `http-verify`) need it resolvable from the working tree, so run `npm install` first.

`schema-verify` additionally imports the registry's own validator out of the npm-global `@deepseek-ai/dsh` install (`@deepseek-ai/dsh-tools`); `report-verify` and the engine suites need a real Moli engine, and `empty-verify` needs a C compiler to build its stub engines. On Windows, `@deepseek-ai/schemastery` can be resolved through a directory junction into the fork's `node_modules` from the npm-global DSH tree, the same way the suites resolve `dsh-tools`.

Beyond those, `lib/moli.js` and the tool layer were exercised end to end against Moli 1.1.16 on
Windows: registration, probe, Markdown and JSON dumps, `eval` (including a tight-timeout regression
guard for the `-t` argument position), PNG and PDF artifacts with valid signatures, truncation, every
rejection path (binary dump without `writeTo`, unknown `dump`, unknown `wait` stage, missing
destination directory), failure classification (unreachable host, HTTP status, sandbox TLS block,
revocation block), and the concurrency claims. The blocked-host classifier is covered by pure
function tests using stderr text captured from real runs.

Confirmed at runtime too: a JavaScript-rendered page (GitHub search) returned 14,560 characters of
Markdown containing 30 real repository matches when fetched through a local proxy. A throwaway
profile with the plugin installed composes its config with no `JsonSchemaError` and no skipped bundle.

## Version note: 1.1.11 and 1.1.12 are deprecated

**Use 1.1.13 or later.** Two releases between them carried an interactive-browser experiment —
`moli_session`, a second Chromium backend, a raw-CDP escape hatch, per-call CDP endpoints, persistent
browser profiles — roughly 2,300 lines of machinery reaching well past what this plugin is for. It has
been removed and the code is back to the 1.1.10 shape plus one focused addition.

The useful finding from that work is kept in [`/lib/moli.js`](lib/moli.js) and appears above as the
`scroll` parameter. Everything else it needed was already in `moli fetch`'s own `--eval`, so the
experiment bought nothing that a parameter could not.

On the versions themselves: npm allows a version to be unpublished only briefly and never
individually, so 1.1.11 and 1.1.12 remain installable but are marked deprecated and point here.
`npm install dsh-moli` resolves to 1.1.13.

## License

MIT. See [LICENSE](LICENSE).

Moli itself is MIT-licensed (Copyright (c) 2026 Moli contributors); this plugin is an independent
integration and is not affiliated with or endorsed by the Moli project.
