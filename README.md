# dsh-moli

[![npm version](https://img.shields.io/npm/v/dsh-moli)](https://www.npmjs.com/package/dsh-moli)
[![license](https://img.shields.io/npm/l/dsh-moli)](LICENSE)

Expose a locally installed [Moli](https://github.com/lexmount/moli) (`moli.exe`, a Rust headless
browser for AI agents) as **DeepSeek Harness tools**, so an agent can call it instead of shelling out.

English | [中文](README.zh.md)

## Quick start

Published on npm as [`dsh-moli`](https://www.npmjs.com/package/dsh-moli):

```powershell
dsh plugin --profile web add dsh-moli
```

That is the recommended route: it resolves through the npm registry, so it also works where GitHub
is slow or unreachable, and DSH's install dialog can fall back to a regional mirror. Installing
straight from the repository works too, and needs GitHub to be reachable:

```powershell
dsh plugin --profile web add github:27painter/dsh-moli
```

Either way, restart DSH, then check the engine and fetch a page:

```
moli_probe
moli_fetch url=https://example.com dump=markdown
```

Moli itself is a separate download. `moli_probe` reports whether it is present, and
`moli_probe action=install` can fetch it. See [Installation](#installation).

## What it provides

| Tool | Purpose |
|---|---|
| `moli_fetch` | Fetch a URL and return rendered HTML, Markdown, the semantic tree, or a JSON envelope (`status`, `final_url`); evaluate a JavaScript expression; write a PNG screenshot or a PDF |
| `moli_probe` | Report the engine path and version and whether HTTPS works; with `action: "install"`, download and install Moli first |

`moli_fetch` parameters: `url` (required), `dump`, `writeTo`, `eval`, `wait`, `waitSelector`,
`delayMs`, `timeoutMs`, `maxChars`, `headers`, `userAgent`, `layout`, `scrollbars`, `noJs`,
`noCss`, `resources`, `withFrames`, `insecureTls`, `profileDir`, `cookieFile`.

```
moli_fetch url=https://example.com dump=markdown            # token-efficient text
moli_fetch url=https://example.com dump=semantic_tree_text   # nodes with backend ids
moli_fetch url=https://example.com eval="document.title"     # one computed value
moli_fetch url=https://example.com dump=screenshot writeTo=/abs/path/a.png
moli_fetch url=https://example.com dump=pdf        writeTo=/abs/path/a.pdf
```

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

## Installation

The plugin is installed into a DSH profile. Pick the route that matches your machine.

### Route A — Moli is already installed

Nothing else to fetch. The plugin finds `moli.exe` on its own and both tools work immediately.

```powershell
dsh plugin --profile web add dsh-moli
```

Install from the repository instead if you prefer tracking the source, or if the registry is
unreachable for you:

```powershell
dsh plugin --profile web add github:27painter/dsh-moli
```

Restart DSH, then confirm with `moli_probe`.

### Route B — Moli is not installed yet

Install the plugin the same way, restart, then let it fetch Moli for you:

```powershell
dsh plugin --profile web add dsh-moli
# restart DSH, then call:
moli_probe action=install
```

The install action tries several download routes in turn and reports every outcome, because a
filtered network can block the release host completely. It reports the SHA256 of the exact bytes it
ran, and `expectedSha256` turns that report into an enforced gate — see
[Verifying the download](#verifying-the-download). Installation only ever runs when a call asks for
it; it is never a side effect of using `moli_fetch`.

### Installing into the desktop profile

`dsh plugin --profile desktop …` is refused — the desktop profile belongs to the Electron app. Either
edit its `package.json` directly (add a `link:` dependency **and** the bundle entry, then run
`pnpm install`), or use the in-app plugin page (sidebar → **Plugins** → **Add plugin**), which goes
through the same pnpm path.

A profile plugin needs both halves: a dependency edge and a `dsh.profile.bundles` entry. One without
the other leaves the plugin invisible to the loader, and an unresolvable bundle is **skipped
silently** apart from one stderr line (`skipping profile bundle …`). If the tools never appear, that
line is the first thing to look for.

## Manual install of Moli

When the automatic routes fail, install Moli yourself. These are Moli's own documented commands.

Windows (PowerShell):

```powershell
powershell -ExecutionPolicy ByPass -c "irm https://github.com/lexmount/moli/releases/latest/download/moli-installer.ps1 | iex"
```

Linux / macOS:

```sh
curl --proto '=https' --tlsv1.2 -fsSL https://github.com/lexmount/moli/releases/latest/download/moli-installer.sh | sh
```

A direct Windows binary is published too, if you would rather not run an installer:

```powershell
# pick the asset matching your architecture from the releases page
curl.exe -L -o moli.zip https://github.com/lexmount/moli/releases/latest/download/moli-x86_64-pc-windows-msvc.zip
Expand-Archive moli.zip -DestinationPath "$env:LOCALAPPDATA\Moli" -Force
```

After any of these, point the plugin at the result if it landed somewhere unusual:

```yaml
config:
  exePath: 'C:\path\to\moli.exe'
```

### Verifying the download

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
ran, and `expectedSha256` enforces a digest you supply. It does not invent a trusted default, because
the digest is only meaningful when compared against the release page's own value.

This is a checked property, not a claim: downloading `v1.1.17`'s installer through
`downloadInstaller` reproduced `e002f7a6…964d` exactly — the same digest GitHub publishes — and
re-hashing the file from disk matched too.

## Three design points

1. **Output goes through file descriptors, never pipes.** Under DSH's Windows sandbox a child
   process cannot open an inherited named pipe, so `spawnSync(..., { stdio: 'pipe' })` returns
   `status=null` and zero bytes. Every run redirects stdout/stderr to real files and reads them back.
2. **Binary output is copied byte for byte.** PowerShell's `>` operator re-encodes a native
   program's output as UTF-16, inserting a `00` after every byte, which corrupts a screenshot.
   Bytes here are written verbatim, so the PNG signature stays `89504e470d0a1a0a`.
3. **No external dependencies.** A profile plugin is loaded from its real path on disk (a `link:`
   dependency stays a symlink target), so a bare specifier such as `@deepseek-ai/schemastery`
   resolves against the plugin directory instead of the profile's `node_modules` and the plugin
   fails to load. This plugin imports only `node:` builtins and its own files.

## Configuration

Override any field under the plugin's `config` entry in the profile patch layer. All are optional.

```yaml
- insert:
    - id: dsh-moli
      name: dsh-moli
      config:
        exePath: 'C:\Users\me\AppData\Local\Moli\bin\moli.exe'  # default: auto-detect
        defaultTimeoutMs: 30000                                  # per-fetch readiness deadline
        maxChars: 200000                                         # inline text truncation
        proxy: 'http://127.0.0.1:7890'                           # forward proxy for moli and downloads
        insecureTls: true                                        # see TLS notes below
```

Without `exePath`, the plugin probes `exePath` → `MOLI_BIN` → `%LOCALAPPDATA%\Moli\bin\moli.exe` →
`%USERPROFILE%\.local\bin\moli.exe`, then scans inside `%LOCALAPPDATA%\Moli` for a `moli.exe`, so an
installation under a versioned subdirectory is still found.

## Known limitations

- **Windows-only targeting.** Developed and tested on Windows; the executable discovery, the
  file-descriptor workaround, and the Schannel notes are Windows-specific. Nothing prevents a
  POSIX port, but it is untested.
- **Moli itself is not bundled.** Install it separately or let `moli_probe action=install` fetch it.
- **Only `fetch` is wrapped.** `moli serve` (CDP/WebDriver server) and `moli import` (session
  import) are not exposed as tools yet.
- **No per-call cancellation.** The engine runs synchronously, so an interrupted turn cannot abort
  a fetch mid-flight. A call already in progress finishes and its artifact is written.
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

`lib/moli.js` and the tool layer were exercised end to end against Moli 1.1.16 on Windows: tool
registration, probe, Markdown and JSON dumps, `eval` (including a tight-timeout regression guard
for the `-t` argument position), PNG and PDF artifacts written with valid signatures, truncation,
every rejection path (binary dump without `writeTo`, unknown `dump`, unknown `wait` stage, missing
destination directory), failure classification (unreachable host, HTTP status, sandbox TLS block,
revocation block), and the concurrency claims. The blocked-host classifier is covered by pure
function tests using stderr text captured from real runs.

Confirmed at runtime as well: a JavaScript-rendered page (GitHub search) returned 14,560 characters
of Markdown containing 30 real repository matches when fetched through a local proxy.

The install pipeline is covered against a loopback HTTP server, which proves the mechanics without
depending on GitHub: route ordering, the SHA256 of served bytes, refusal to execute on a checksum
mismatch, actual execution when the digest matches, and the all-routes-failed diagnostic.

## License

MIT. See [LICENSE](LICENSE).

Moli itself is MIT-licensed (Copyright (c) 2026 Moli contributors); this plugin is an independent
integration and is not affiliated with or endorsed by the Moli project.
