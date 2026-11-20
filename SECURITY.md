# Security policy

## Supported versions

Security fixes are provided for the current `3.x` release line. Older releases
may not receive fixes.

## Reporting a vulnerability

Please use GitHub's private vulnerability reporting for this repository:

https://github.com/27painter/dsh-moli/security/advisories/new

Do not include credentials, cookies, private page content, proxy passwords, or
other sensitive data in a public issue. Include the affected version, platform,
tool name, reproduction steps, expected behavior, and observed behavior.

## Trust and execution model

`dsh-moli` and the Codex `Moli Browser` plugin are independent open-source
integrations. They are not affiliated with or endorsed by OpenAI, Moli, or
Lexmount.

The Codex plugin runs a local stdio MCP server. The server is bundled from this
repository and starts the locally installed Moli executable as a child process.
It does not upload browsing data, prompts, cookies, screenshots, PDFs, or tool
results to a server operated by the plugin author.

The plugin exposes these capability boundaries:

- `moli_search` and `moli_fetch` read public web content or explicitly supplied
  URLs. They do not intentionally modify external services.
- `moli_capture` writes a PNG or PDF only to the explicit output path supplied
  by the caller.
- `moli_probe` inspects the local installation. With `action: "install"`, it
  downloads and executes Moli's official installer. Installation is never
  implicit and must be explicitly requested by the user or agent.

MCP clients should review tool arguments before approving file writes, cookie
file access, persistent browser profiles, or Moli installation.

## Network access

Search and page requests originate from the user's machine. Proxy configuration
can be supplied with `MOLI_PROXY`, `HTTPS_PROXY`, `HTTP_PROXY`, or `ALL_PROXY`,
or per tool call. Proxy credentials remain in the local environment or tool
arguments.

TLS host verification is enabled by default. `MOLI_INSECURE_TLS=1` and the
per-call `insecureTls` option disable host verification only when explicitly
requested for a known certificate problem. They should not be enabled by
default.

Cookie files and persistent profile directories can contain authentication
material. Use test or dedicated profiles where possible and never attach a
cookie file you do not trust the agent to read.

## Prompt injection and untrusted content

Web pages, search results, and downloaded page content are untrusted input.
Tool descriptions and skill instructions tell the model not to follow
instructions found in fetched content. Clients should preserve sandboxing and
approval boundaries instead of treating fetched content as trusted policy.

## Supply chain

- The Moli engine is installed from the official `lexmount/moli` release source
  and is not redistributed by this repository.
- The plugin bundle is generated from the repository's audited `lib/moli.js`
  and `lib/install.js` sources.
- GitHub Actions are pinned to full commit SHAs.
- npm dependencies are locked by `package-lock.json`.
