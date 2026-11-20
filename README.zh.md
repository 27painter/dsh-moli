# dsh-moli

[![npm 版本](https://img.shields.io/npm/v/dsh-moli)](https://www.npmjs.com/package/dsh-moli)
[![license](https://img.shields.io/npm/l/dsh-moli)](LICENSE)
[![跨 Agent：DSH | Codex | OpenCode](https://img.shields.io/badge/%E8%B7%A8_Agent-DSH_%7C_Codex_%7C_OpenCode-6f42c1?style=for-the-badge)](#安装)
[![已收录于 awesome-dsh-plugin](https://img.shields.io/badge/awesome--dsh--plugin-%E5%B7%B2%E6%94%B6%E5%BD%95-3964fe)](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin)
[![HOL 信任分](https://img.shields.io/endpoint?url=https%3A%2F%2Fhol.org%2Fapi%2Fregistry%2Fbadges%2Fplugin%3Fslug%3D27painter%252Fmoli%26metric%3Dtrust%26style%3Dfor-the-badge)](https://hol.org/registry/plugins/27painter%2Fmoli)
[![已收录于 Awesome Codex Plugins](https://img.shields.io/badge/Awesome_Codex_Plugins-%E5%B7%B2%E6%94%B6%E5%BD%95-3964fe)](https://github.com/hashgraph-online/awesome-codex-plugins)

面向 **DeepSeek Harness（DSH）**、**Codex** 与 **OpenCode** 的本地浏览器桥。
它封装 [Moli](https://github.com/lexmount/moli)——一个为 AI agent 打造的 Rust 无头浏览器——用于抓取
JavaScript 渲染页面、搜索网页，以及生成截图或 PDF。

[English](README.md) | 中文

## 为什么使用

当 `web_fetch`、`curl` 或普通 HTTP 请求不够用时，使用这个插件：

- 客户端渲染的应用与文档；
- 依赖 Cookie、同意页或登录状态的页面；
- 懒加载或触发 `scroll` 后才出现的内容；
- 截图、PDF，或从大页面中提取少量值。

普通文章、API 和静态 HTML 用宿主的 `web_fetch` 更轻、更快。

| 使用端 | 提供的能力 |
|---|---|
| DSH | `moli_fetch`、`moli_probe` |
| Codex | `moli_search`、`moli_fetch`、`moli_capture`、`moli_probe` |
| OpenCode | 免费 `websearch` 提供方，以及 `moli_fetch`、`moli_capture`、`moli_probe` |

三个适配器共用同一套浏览器核心和本机安装的 `moli` 引擎。

## 安装

要求 Node.js `>=20.12` 和 Moli 引擎。引擎是平台相关的原生二进制，由 Moli 上游单独发布，因此不随插件打包。

### 1. 安装 Moli 引擎

最简单的方式是调用插件：

```text
moli_probe action=install
```

也可以使用 Moli 官方安装器：

```powershell
# Windows
powershell -ExecutionPolicy ByPass -c "irm https://github.com/lexmount/moli/releases/latest/download/moli-installer.ps1 | iex"
```

```sh
# Linux / macOS
curl --proto '=https' --tlsv1.2 -fsSL https://github.com/lexmount/moli/releases/latest/download/moli-installer.sh | sh
```

如果引擎不在标准目录，可为 Codex/OpenCode 设置 `MOLI_BIN`，或为 DSH 设置 `exePath`。

### 2. 安装适配器

#### DSH

```powershell
dsh plugin --profile web add dsh-moli
```

desktop profile 请在应用内的 **插件 → 添加插件** 页面安装；CLI 不允许直接修改 Electron 管理的
desktop profile。

#### Codex

```powershell
codex plugin marketplace add 27painter/dsh-moli --ref main
codex plugin add moli@27painter-codex
```

安装后新建一个 Codex 会话。Codex 不支持直接从 npm 安装插件，只能通过本地或 Git marketplace 解析。

Codex 收录页：[Awesome Codex Plugins](https://github.com/hashgraph-online/awesome-codex-plugins) ·
[HOL 插件目录](https://hol.org/registry/plugins/27painter%2Fmoli)

#### OpenCode

```powershell
opencode plugin add opencode-moli@3.1.0
```

或写入 `opencode.json` / `opencode.jsonc`：

```json
{
  "plugins": ["opencode-moli@3.1.0"]
}
```

OpenCode 专用选项与环境变量见
[`plugins/opencode-moli/README.md`](plugins/opencode-moli/README.md)。

## 快速开始

```text
moli_probe
moli_fetch url=https://example.com dump=markdown
moli_fetch url=https://example.com selector="main"
moli_fetch url=https://example.com dump=screenshot writeTo=/absolute/path/page.png
```

Codex 还可以使用浏览器搜索：

```text
moli_search query="current Rust release"
```

在 OpenCode 中，插件会注册 `moli` 搜索提供方，因此内置 `websearch` 工具无需额外的搜索 API Key。

## 用法

`moli_fetch` 支持：

```text
url, dump, writeTo, selector, eval, scroll, wait,
waitSelector, waitScript, waitResponseUrl, waitResponseJson, delayMs,
timeoutMs, maxChars, headers, userAgent, layout, scrollbars, noJs,
noCss, resources, withFrames, insecureTls, failOnHttpError,
profileDir, cookieFile, proxy
```

常用调用：

```text
moli_fetch url=https://example.com dump=markdown
moli_fetch url=https://example.com dump=semantic_tree_text
moli_fetch url=https://example.com eval="document.title"
moli_fetch url=https://example.com selector=".video-card"
moli_fetch url=https://example.com/feed selector="h2" scroll=2000
moli_fetch url=https://example.com dump=pdf writeTo=/absolute/path/page.pdf
moli_fetch url=https://example.com/missing failOnHttpError=true
```

### 列表优先使用 `selector`

`selector` 只返回匹配到的元素，不把整页内容交给模型：

```text
moli_fetch url=https://example.com/feed selector=".video-card"
```

读取搜索结果、信息流、表格和商品列表时，它通常最省 token，也最容易得到干净结果。没有匹配项会报错；
`selector` 不能与 `dump` 或 `eval` 同时使用。

### 等待真正的响应

相比固定延迟，优先等待具体信号：

```text
moli_fetch url=https://example.com/feed waitResponseUrl="/api/feed"
moli_fetch url=https://example.com/feed waitResponseJson="data.list.0.id=42"
moli_fetch url=https://example.com/app waitScript="window.appReady === true"
```

`scroll` 会在抓取前触发懒加载。`eval` 不搭配 `dump` 时返回表达式值；同时使用时表达式值会被丢弃，
结果会标记 `evalDiscarded`。

## 配置

DSH 配置是可选的，写在 profile patch 层：

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

这些字段也可以在 DSH 插件设置页修改。

Codex 读取以下环境变量：

| 变量 | 默认值 |
|---|---|
| `MOLI_BIN` | 自动探测引擎路径 |
| `MOLI_PROXY` | 现有 `HTTPS_PROXY`、`HTTP_PROXY` 或 `ALL_PROXY` |
| `MOLI_SEARCH_URLS` | Bing → DuckDuckGo HTML → Brave |
| `MOLI_TIMEOUT_MS` | `30000` |
| `MOLI_MAX_CHARS` | `200000` |
| `MOLI_INSECURE_TLS` | `0` |

如果希望 Codex 默认用 Moli 搜索，把下面内容放在第一个 TOML table 之前：

```toml
web_search = "disabled"

[plugins."moli@27painter-codex"]
enabled = true
```

OpenCode 在插件项中接受对应选项，也读取相同的 `MOLI_*` 环境变量。详见
[`plugins/opencode-moli/README.md`](plugins/opencode-moli/README.md)。

## 平台支持

| 平台 | 状态 |
|---|---|
| Windows | 维护者实测 |
| Linux | [@nd002723](https://github.com/nd002723) 贡献并在 Ubuntu 24.04 验证 |
| macOS | Apple Silicon CI 使用真实引擎验证 |

插件会查找 Moli 的标准安装目录和 `$PATH`。安装在其他位置时设置 `MOLI_BIN` 或 `exePath`。

## 已知限制

- Moli 引擎不包含在任何 npm 包中。
- 暂不提供 Moli 的 CDP/WebDriver server 和会话导入命令。
- 普通抓取无法中途取消；引擎安装是异步的。
- `insecureTls` 默认 `true`，用于兼容带过滤代理的网络；健康网络建议设为 `false`。
- 需要把 4xx/5xx 视为失败时，使用 `failOnHttpError=true`。
- 部分 Windows DSH 沙箱需要 `danger-full-access` 才能完成 HTTPS 请求。
- `writeTo` 产物写入会串行执行。

## 开发

```powershell
npm install
npm run build:codex
npm run verify:codex
npm run build:opencode
node verify/empty-verify.mjs
```

主 CI 覆盖 Windows、Linux 和 macOS；依赖引擎的测试会下载真实 Moli release。完整测试脚本位于
[`verify/`](verify/)，GitHub Actions 是完整验证结果的准绳。

## 安全

本地执行、网络、代理、Cookie、TLS 和安装器边界见 [SECURITY.md](SECURITY.md)。

## 版本

### 3.1.0

新增原生 OpenCode V2 适配器，包括免费搜索、`moli_fetch`、`moli_capture` 与 `moli_probe`。
DSH 与 Codex 的工具契约保持不变。

<details>
<summary>更早版本</summary>

- **2.1.1** — 增加 Codex 目录元数据、安全文件、固定 SHA 的 Actions 和 HOL 扫描工作流。
- **2.1.0** — 增加 Codex MCP 适配器及 search、fetch、capture、probe 工具。
- **1.1.11 / 1.1.12** — 已废弃，请使用当前维护版本。

</details>

## 许可

MIT，见 [LICENSE](LICENSE)。Moli 同样采用 MIT 许可；本项目是独立集成，与 Moli 项目无从属或背书关系。
