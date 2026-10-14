# dsh-moli

**两个工具，让 DeepSeek Harness 的 agent 能驱动真正的无头浏览器。** 它们封装
[Moli](https://github.com/lexmount/moli)——一个专为 AI agent 打造的 Rust 无头浏览器——所以 agent 能看到
那些"必须跑完 JavaScript 才存在"的页面内容，也能把它们拍成图。

[English](README.md) | 中文

## 它做什么，什么时候需要它

普通的 HTTP 抓取拿回的是服务器发来的 HTML。对文章、文档、API 来说这足够了，DSH 的 `web_fetch` 已经覆盖
这种场景。但它拿不到任何**需要浏览器构建出来**的内容：

- **单页应用（SPA）**——客户端渲染的新闻站、仪表盘、文档站。响应只是一个空壳，内容要等脚本跑完才出现。
- **登录与同意墙**——必须先有会话或 cookie 才肯显示内容的页面。
- **图**——想看一眼页面长什么样（截图），或想存档（PDF）。
- **页面深处的一个值**——价格、计数、标题，用选择器直接取，而不是把整篇文档拉回来。

针对这些场景，本插件给 agent 两个工具：

| 工具 | 作用 |
|---|---|
| `moli_fetch` | 渲染 URL 并返回 Markdown / HTML / 语义树 / 带 HTTP 状态的 JSON；执行 JS 表达式取值；写出 PNG 截图或 PDF |
| `moli_probe` | 报告引擎是否安装、什么版本、HTTPS 是否可用；没装时还能替你装上 |

判断标准很简单：**agent 需要的是"浏览器眼里的页面"吗？** 如果普通抓取已经能拿到你要的文字，`web_fetch`
更轻更快。

```
  agent ──moli_fetch──▶ dsh-moli 插件 ──启动──▶ moli.exe
                            ▲                      │
                            │                 渲染页面、
                            │                 执行其中 JavaScript
                            │                      │
                            └──markdown / json / png / pdf◀┘
```

## 安装

两条路，装的是同一个插件，按你的网络情况选。

**路线 1 —— 从 npm 装（推荐）。** 经 npm registry 解析，所以在 GitHub 慢或不通的网络里照样能装，DSH 的
安装对话框还能回退到国内镜像：

```powershell
dsh plugin --profile web add dsh-moli
```

**路线 2 —— 直接从仓库装。** 直接跟踪源码，需要 GitHub 可达：

```powershell
dsh plugin --profile web add github:27painter/dsh-moli
```

> [!IMPORTANT]
> **npm 包只有插件，不含 Moli 引擎。**
>
> npm tarball 是 26 kB：八个 JavaScript 与文本文件。`moli.exe` 是另外的东西——约 101 MB 的 Rust 编译
> 产物，由 Moli 项目按自己的节奏构建和发布。
>
> **为什么不能打包进来：**
>
> - **体积。** 引擎约为插件的 4,000 倍。每次安装、每次插件更新都要顺带搬运一个浏览器。
> - **归属。** Moli 是 `lexmount/moli`，版权属于它自己的 MIT 署名。把它家的二进制经由本包再分发，等于
>   把别人的产物当自己的发布。
> - **平台。** 引擎按操作系统与架构分别发布——Windows/Linux/macOS × x64/arm64。打包进来等于把某一个
>   构建方式钉死给所有用户。
> - **版本。** 插件要能配合用户手上**任意** Moli 版本工作，包括插件发布之后才出现的 Moli 新版本。
>   打包会把两者的版本绑死。
>
> **引擎同样没有 npm 包。** registry 上的 `moli` 和 `moli-cli` 属于无关项目，`@lexmount/moli` 并不
> 存在。Moli 以预编译二进制形式发布在
> [GitHub Releases](https://github.com/lexmount/moli/releases/latest)——**不要靠猜包名去装引擎**。

## 装好之后的两种情形

上面两条下载路线装的是同一个东西。区别在于**你的机器上有没有 Moli**——这决定你是就此完事，还是还差一步。

### 情形 A —— 已经装了 Moli：不用再做别的

插件自己会找到 `moli.exe`，两个工具立即可用。重启 DSH 然后确认：

```
moli_probe
```

如果报出来的版本正常，就结束了。

### 情形 B —— 还没装 Moli：把引擎也拉下来

在你装上引擎之前，`moli_fetch` 会一直报"引擎缺失"。用下面任一种装上：

```
moli_probe action=install          # 让插件替你拉
```

```powershell
# 或者自己跑 Moli 官方的安装器
powershell -ExecutionPolicy ByPass -c "irm https://github.com/lexmount/moli/releases/latest/download/moli-installer.ps1 | iex"
```

然后用 `moli_probe` 确认并抓一个页面：

```
moli_probe
moli_fetch url=https://example.com dump=markdown
```

### 获取 Moli 引擎

`moli_probe` 会报告引擎是否在场。如果不在，三种方式任选：

**1. 让插件替你装**——多路径下载，并报告实际执行字节的 SHA256。整个过程异步（主机照常服务），配置的
`proxy` 会同时传给下载路由与安装器内部的引擎下载：

```
moli_probe action=install
```

**2. 官方一行安装**（Moli 自己的文档命令）：

```powershell
# Windows
powershell -ExecutionPolicy ByPass -c "irm https://github.com/lexmount/moli/releases/latest/download/moli-installer.ps1 | iex"
```

```sh
# Linux / macOS
curl --proto '=https' --tlsv1.2 -fsSL https://github.com/lexmount/moli/releases/latest/download/moli-installer.sh | sh
```

**3. 直接下二进制**（不想跑安装器的话）：

```powershell
# 从 releases 页挑与你架构匹配的资产
curl.exe -L -o moli.zip https://github.com/lexmount/moli/releases/latest/download/moli-x86_64-pc-windows-msvc.zip
Expand-Archive moli.zip -DestinationPath "$env:LOCALAPPDATA\Moli" -Force
```

这些 `releases/latest/download/...` 链接始终指向最新发布，所以不用钉版本号也不会失效。

装完若位置不常规，把插件指过去：

```yaml
config:
  exePath: 'C:\path\to\moli.exe'
```

#### 校验下载

Moli 的 README 没有记录任何校验和或签名，安装器也不发布校验和文件。**存在的是 GitHub 自己给每个资产的
`sha256` 摘要**，可以从 release API 读到：

```powershell
(irm https://api.github.com/repos/lexmount/moli/releases/latest).assets | Select-Object name, digest
```

`v1.1.17` 下这个命令会给出（节选）：

```
moli-installer.ps1                2,020  sha256:e002f7a6c174d78ae6ed7289aca9f5d3a62ab0b1f6e588606a80c0cb5d37964d
moli-x86_64-pc-windows-msvc.zip  43.8 MB  sha256:5247309837b6eaf6e73bfa18f2a8d8d90473b9e2fe5cfcaaef57d7eee9b074c4
```

与你下载的文件比对：

```powershell
(Get-FileHash .\moli-installer.ps1 -Algorithm SHA256).Hash.ToLower()
```

插件遵循同样的纪律：`moli_probe action=install` 会报告它实际执行的那份字节的 SHA256，而
`expectedSha256` 能把这份报告变成强制校验门。它**不会**编造一个可信默认值——因为摘要只有在与发布页自己
的值比对时才有意义。

这是**验证过的性质，不是声明**：用插件自己的 `downloadInstaller` 下载 `v1.1.17` 的安装器，复现出的正是
GitHub 公布的那个摘要 `e002f7a6…964d`，从磁盘重新哈希也对得上。

### 装进 desktop profile

`dsh plugin --profile desktop …` 会被拒绝——desktop profile 归 Electron 应用所有。直接改它的
`package.json`，或用应用内插件页（侧边栏 →**插件**→**添加插件**），那条路径同样走 pnpm。

profile 插件需要两半都齐：依赖边（`dependencies`）+ `dsh.profile.bundles` 条目。缺一个 loader 就看不到
它。从本地目录安装的完整四步是：

1. 把本目录放到任意位置，例如 `D:\dsh_plugins\dsh-moli`。
2. 在该 profile 的 `package.json` 中加入两项：
   - `dependencies`: `"dsh-moli": "link:D:/dsh_plugins/dsh-moli"`
   - `dsh.profile.bundles`: `"dsh-moli"`
3. 在 profile 目录执行 `pnpm install`（生成 `node_modules/dsh-moli`）。
4. 重启 DSH。

无法解析的 bundle 会被**静默跳过**，只在 stderr 留一行 `skipping profile bundle …`。工具迟迟不出现时先找
这行。

## 用法

`moli_fetch` 参数：`url`（必填）、`dump`、`writeTo`、`eval`、`wait`、`waitSelector`、`delayMs`、
`timeoutMs`、`maxChars`、`headers`、`userAgent`、`layout`、`scrollbars`、`noJs`、`noCss`、
`resources`、`withFrames`、`insecureTls`、`profileDir`、`cookieFile`。

```
moli_fetch url=https://example.com dump=markdown            # 省 token 的正文
moli_fetch url=https://example.com dump=semantic_tree_text   # 带节点 id 的结构
moli_fetch url=https://example.com eval="document.title"     # 取一个值
moli_fetch url=https://example.com dump=screenshot writeTo=/绝对路径/a.png
moli_fetch url=https://example.com dump=pdf        writeTo=/绝对路径/a.pdf
```

截图与 PDF 必须给 `writeTo`；字节是原样落盘的，不会打印到输出里。

## 与 Moli 官方 agent skill 的关系

Moli 仓库自带官方 agent skill：[`moli-webfetch`](https://github.com/lexmount/moli/tree/main/skills/moli-webfetch)、
[`moli-websearch`](https://github.com/lexmount/moli/tree/main/skills/moli-websearch)、
[`moli-cdp-server`](https://github.com/lexmount/moli/tree/main/skills/moli-cdp-server)，其 README 的快速开始
就是让 agent 去安装它们。如果你的 agent 能加载 skill，最省事的路就是直接用官方那套——上游维护，而且额外覆盖
网页搜索与 CDP 服务。

本插件的存在是因为它是另一种取舍，不是替代品：

- **常驻工具 schema，而非按需 skill。** 工具在 Host 启动时注册，模型每回合都能看到，不需要发现步骤。
- **针对 DSH 的失败处理。** 下面那三个坑（沙箱管道捕获、二进制被 UTF-16 破坏、`link:` 插件的裸包名解析）
  以及沙箱/吊销/代理三类失败分类，都在这里解决了——因为它们本质是"DSH on Windows"的问题。
- **面更窄。** 只封装了 `fetch`；官方 skill 还覆盖网页搜索和 CDP 服务，本插件没有。

两者可以共存：想要上游覆盖就装 skill，想要能力始终对模型可见就留这个插件。

## 三个设计要点

1. **输出走文件描述符，不走管道。** DSH 的 Windows 沙箱禁止子进程打开继承的命名管道，
   `spawnSync(..., { stdio: 'pipe' })` 会得到 `status=null` 与 0 字节。本项目始终把 stdout/stderr
   重定向到临时文件再读回。
2. **二进制按原始字节落盘。** PowerShell 的 `>` 会把原生程序输出按 UTF-16 重编码（每字节后插
   `00`），截图因此损坏。这里直接写字节，PNG 签名保持 `89504e470d0a1a0a`。
3. **零外部依赖。** profile 插件按磁盘真实路径加载（`link:` 依赖仍是符号链接目标），任何裸包名
   导入（例如 `@deepseek-ai/schemastery`）都会解析到插件目录而非 profile 的 `node_modules`，导致
   插件加载失败。本插件只导入 `node:` 内置模块和自己的文件。

## 平台支持

支持 **Windows、Linux、macOS**（x64 / arm64）。

> **Linux 与 macOS 支持由 [@nd002723](https://github.com/nd002723) 贡献**，见
> [PR #1](https://github.com/27painter/dsh-moli/pull/1)：POSIX 标准位置的引擎探测、`sh` 安装器路径，
> 以及把 PowerShell 相关路径按平台门控。

| 平台 | 状态 |
|---|---|
| **Windows** | 由维护者验证 |
| **Linux** | **由贡献者验证，非维护者**：Ubuntu 24.04 LTS、Node v24.21.0、Moli 1.1.17——含异步安装路径、代理注入、以及 strace 记录的全链路抓取 |
| **macOS** | 已实现，尚未在真机验证 |

- **Windows** —— 引擎在官方安装位置查找（`%LOCALAPPDATA%\Moli\bin\moli.exe` 与 `%USERPROFILE%\.local\bin\moli.exe`），
  并以 `%LOCALAPPDATA%\Moli` 递归扫描兜底；`moli_probe action=install` 走官方 PowerShell 安装器。
- **Linux / macOS** —— 引擎在标准位置（`~/.local/bin/moli`、`~/.local/share/moli/bin/moli`、
  `~/.local/share/moli/moli`、`~/.moli/bin/moli`）与 `$PATH` 中查找；`moli_probe action=install` 通过 `sh` 执行官方 `moli-installer.sh`。

**安装绝不阻塞 DSH 主机。** 安装器的下载与执行都以异步 spawn 进行，超时先 SIGTERM 再 SIGKILL，
被中断的回合会立刻终止子进程——Moli 安装器干活期间主机照常服务。用 `strace -e trace=connect`
对真实安装抓包，记录的每次连接都走配置的代理端口、没有任何直连上游主机；fixture 安装器也确认
代理进入了子进程的环境。

配置的 `proxy` **同时喂两个阶段**：插件自己的下载路由（`curl --proxy`，以及 PowerShell `Invoke-WebRequest`
的 `-Proxy`），以及官方安装器内部的引擎下载——Windows 上通过 `DefaultWebProxy` prelude（PowerShell
的 `Invoke-WebRequest` 不读代理环境变量），POSIX 上通过安装器 `curl` 会读取的标准 `HTTPS_PROXY`/
`HTTP_PROXY`/`ALL_PROXY` 变量。带凭据的代理会显式设置凭据。

在 Linux 上，`moli_probe` 无需干预就找到了 `~/.local/bin/moli`；`moli_fetch` 端到端渲染了一个地区限制的
电商站——经由本地正向代理、并带上 Netscape 格式的 `cookieFile`——返回 500+ KB 的页面，最终 URL 带上了
cookie 驱动的查询参数。那次实测同时覆盖了代理下载路由与引擎探测路径。

## 配置

在 profile 的补丁层里覆盖 `config`，全部可选：

```yaml
- insert:
    - id: dsh-moli
      name: dsh-moli
      config:
        exePath: 'C:\Users\me\AppData\Local\Moli\bin\moli.exe'  # 默认自动探测
        defaultTimeoutMs: 30000                                  # 单次抓取就绪超时
        maxChars: 200000                                         # 内联文本截断阈值
        proxy: 'http://127.0.0.1:7890'                           # 转给本地正向代理（moli、下载、安装器内部引擎下载都走它）
        insecureTls: true                                        # 见下方 TLS 说明
```

未设置 `exePath` 时探测顺序：`exePath` → 环境变量 `MOLI_BIN` → `%LOCALAPPDATA%\Moli\bin\moli.exe`
→ `%USERPROFILE%\.local\bin\moli.exe`，随后还会在 `%LOCALAPPDATA%\Moli` 内递归查找 `moli.exe`，
所以装在带版本号的子目录里也能找到。

## 已知限制

- **macOS 未经验证，Linux 是由贡献者而非维护者验证的。** 维护者是一名**没有 macOS / Linux 电脑**的
  大学生；Linux 由 [@nd002723](https://github.com/nd002723) 在 Ubuntu 24.04 上独立验证通过（见
  [平台支持](#平台支持)），而 macOS 从未在真机运行过。**任一平台出问题，都请带上报错信息开
  [issue](https://github.com/27painter/dsh-moli/issues)**——那是这些路径能被打通的唯一途径。
- **不包含 Moli 本体。** 需自行安装，或让 `moli_probe action=install` 替你拉取。
- **只封装了 `fetch`。** `moli serve`（CDP/WebDriver 服务器）与 `moli import`（会话导入）尚未做成工具。
- **抓取不支持单次取消。** 引擎对抓取是同步执行的，被中断的回合无法中途终止；已在进行的调用会跑完并
  写出产物。`moli_probe action=install` 是例外——它是异步的，被中断的回合会立刻终止子进程。
- **HTTP 错误码只在 `dump: json` 下可见。** 那是唯一携带状态字段的格式；用 `markdown` 或 `html`
  时错误页会作为内容返回。
- **`writeTo` 调用被串行化。** 它们声明为不可并行，因此两次产物写入不会交错。
- **`insecureTls` 默认为 `true`。** 在过滤代理后面，证书吊销响应者常常不可达，Schannel 于是在
  GitHub 这类站点上报 `CRYPT_E_REVOCATION_OFFLINE (0x80092013)`。默认传 moli 的
  `--insecure-disable-tls-host-verification`；在吊销检查可用的网络里改成 `insecureTls: false`，
  或按次传 `insecureTls: false`。
- **与沙箱的交互。** DSH 默认文件沙箱下子进程是低完整性，Schannel 拿不到客户端凭证，HTTPS 会报
  `SEC_E_NO_CREDENTIALS`。纯 HTTP 仍可用，且失败会被结构化上报（`sandboxTlsBlock: true`）并给出
  重试方式；该次调用带 `sandbox_permissions: "danger-full-access"` 即可通过。
- **部分网络下主机可达性会波动。** 开发机上观察到的现象：同一时刻，基于 curl 的客户端（moli）访问
  `github.com` 超时，而 `git` over HTTPS 与系统浏览器几秒内就能通；`api.github.com` 正常而
  `github.com` 不通。所以超时可能是暂时性的——重试，或设置 `proxy`。正因裸超时含义不唯一，它被
  上报为 `possiblyUnreachable` 而不当作定论。安装动作的多路径回退与上面的手动命令正是为这种情况准备的。

## 验证情况

[`verify/`](verify/) 下有四个可直接对工作区运行的测试：

- `schema-verify.mjs` 用注册表自己的校验器检查工具定义，并带有断言"两种非法 schema 形状仍会被拒"的对照组。
- `install-verify.mjs` 用本地回环 HTTP 服务器驱动安装链路：路由顺序、被提供字节的 SHA256、校验不匹配时
  拒绝执行、匹配时真正执行、以及全部路径失败的诊断。
- `linux-verify.mjs`（POSIX 主机）断言代理辅助函数，然后对真实安装验证异步改造的两个保证：安装器子进程
  确实通过环境收到代理（fixture 安装器捕获 `HTTPS_PROXY`），以及慢安装器运行期间主机事件循环保持活跃——
  这正是异步路径的验收标准。
- `win-verify.mjs`（Windows 主机）跑同样的纯函数断言，然后在真实 `powershell.exe` 里执行 `DefaultWebProxy`
  prelude 并检查它设置的代理对象与凭据，练习 Windows 下载路由，并端到端跑 `installMoli`。

此外，`lib/moli.js` 与工具层在 Windows 上对 Moli 1.1.16 做了端到端验证：注册、probe、Markdown 与 JSON
dump、`eval`（含针对 `-t` 参数位置的紧超时回归防护）、PNG 与 PDF 产物签名、截断、全部拒绝路径（二元 dump
缺 `writeTo`、非法 `dump`、非法 `wait`、目标目录不存在）、失败分类（不可达主机、HTTP 状态、沙箱 TLS 阻断、
吊销阻断）以及并发声明。被阻断主机的分类器用真实运行捕获的 stderr 文本做纯函数测试。

运行时也确认过：走本地代理抓取 JavaScript 渲染页面（GitHub 搜索）返回 14,560 字符 Markdown，其中包含
30 处真实结果匹配。另有一个装了本插件的一次性 profile，组合其配置时既无 `JsonSchemaError` 也无被跳过的
bundle。

## 许可

MIT，见 [LICENSE](LICENSE)。

Moli 本体也是 MIT（Copyright (c) 2026 Moli contributors）；本插件是独立的集成项目，与 Moli 项目无从属
或背书关系。
