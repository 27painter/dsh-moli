# dsh-moli

把本机安装的 [Moli](https://github.com/lexmount/moli)（`moli.exe`，Rust 编写的 AI agent 无头浏览器）暴露成 **DeepSeek Harness 工具**，让 agent 直接调用，不必每次手敲命令。

[English](README.md) | 中文

## 快速开始

已发布到 npm：[`dsh-moli`](https://www.npmjs.com/package/dsh-moli)

```powershell
dsh plugin --profile web add dsh-moli
```

**推荐走这条**：它经 npm registry 解析，所以在 GitHub 慢或不通的网络里照样能装，而且 DSH 的安装对话框能
回退到国内镜像。直接从仓库装也可以，但需要 GitHub 可达：

```powershell
dsh plugin --profile web add github:27painter/dsh-moli
```

两种方式都要重启 DSH，然后自检并抓一个页面：

```
moli_probe
moli_fetch url=https://example.com dump=markdown
```

Moli 本体是另外下载的。`moli_probe` 会报告它是否在场，`moli_probe action=install` 可以替你拉取。
详见[安装](#安装)。

## 与 Moli 官方 agent skill 的关系

Moli 仓库自带官方 agent skill：[`moli-webfetch`](https://github.com/lexmount/moli/tree/main/skills/moli-webfetch)、
[`moli-websearch`](https://github.com/lexmount/moli/tree/main/skills/moli-websearch)、
[`moli-cdp-server`](https://github.com/lexmount/moli/tree/main/skills/moli-cdp-server)，其 README 的快速开始
就是让 agent 去安装它们。如果你的 agent 能加载 skill，最省事的路就是直接用官方那套——上游维护，而且额外覆盖网页
搜索与 CDP 服务。

本插件的存在是因为它是另一种取舍，不是替代品：

- **常驻工具 schema，而非按需 skill。** 工具在 Host 启动时注册，模型每回合都能看到，不需要发现步骤。
- **针对 DSH 的失败处理。** 下面那三个坑（沙箱管道捕获、二进制被 UTF-16 破坏、`link:` 插件的裸包名解析）
  以及沙箱/吊销/代理三类失败分类，都在这里解决了——因为它们本质是"DSH on Windows"的问题。
- **面更窄。** 只封装了 `fetch`；官方 skill 还覆盖网页搜索和 CDP 服务，本插件没有。

两者可以共存：想要上游覆盖就装 skill，想要能力始终对模型可见就留这个插件。

## 提供的能力

| 工具 | 作用 |
|---|---|
| `moli_fetch` | 抓取 URL 并返回渲染后的 HTML / Markdown / 语义树 / JSON（含 `status` 与 `final_url`）；执行 JS 表达式取值；写出 PNG 截图或 PDF |
| `moli_probe` | 报告引擎路径与版本，以及调用进程能否走 HTTPS |

`moli_fetch` 参数：`url`（必填）、`dump`、`writeTo`、`eval`、`wait`、`waitSelector`、`delayMs`、
`timeoutMs`、`maxChars`、`headers`、`userAgent`、`layout`、`scrollbars`、`noJs`、`noCss`、
`resources`、`withFrames`、`insecureTls`、`profileDir`、`cookieFile`。

```
moli_fetch url=https://example.com dump=markdown           # 省 token 的正文
moli_fetch url=https://example.com dump=semantic_tree_text  # 带节点 id 的结构
moli_fetch url=https://example.com eval="document.title"    # 取一个值
moli_fetch url=https://example.com dump=screenshot writeTo=/绝对路径/a.png
moli_fetch url=https://example.com dump=pdf        writeTo=/绝对路径/a.pdf
```

## 安装

插件装进某个 DSH profile。按你的机器情况选一条路。

### 路线 A —— 已经装了 Moli

不需要再装别的东西。插件自己会找到 `moli.exe`，两个工具立即可用。

```powershell
dsh plugin --profile web add dsh-moli
```

若你更想跟踪源码，或 registry 对你不可达，改从仓库装：

```powershell
dsh plugin --profile web add github:27painter/dsh-moli
```

重启 DSH，然后用 `moli_probe` 确认。

### 路线 B —— 还没装 Moli

同样方式装插件、重启，然后让它替你把 Moli 拉下来：

```powershell
dsh plugin --profile web add dsh-moli
# 重启 DSH，然后调用：
moli_probe action=install
```

安装动作会**依次尝试多条下载路径**并逐条报告结果——因为受限网络可能把 release 主机整个挡掉。它会报告
实际执行的字节的 SHA256，而 `expectedSha256` 能把这份报告变成强制校验门（见
[校验下载](#校验下载)）。安装**只在调用明确要求时**发生，使用 `moli_fetch` 永远不会触发它。

### 装进 desktop profile

`dsh plugin --profile desktop …` 会被拒绝——desktop profile 归 Electron 应用所有。直接改它的
`package.json`（加 `link:` 依赖**和** bundle 条目，再跑 `pnpm install`），或用应用内插件页
（侧边栏 →**插件**→**添加插件**），那条路径同样走 pnpm。

profile 插件需要两半都齐：依赖边 + `dsh.profile.bundles` 条目。缺一个 loader 就看不到它，而无法解析的
bundle 会被**静默跳过**，只在 stderr 留一行 `skipping profile bundle …`。工具迟迟不出现时先找这行。

## 手动安装 Moli

自动路径都失败时（受限网络可能把 release 主机整个挡掉），自己装。下面是 Moli 官方文档里的命令。

Windows（PowerShell）：

```powershell
powershell -ExecutionPolicy ByPass -c "irm https://github.com/lexmount/moli/releases/latest/download/moli-installer.ps1 | iex"
```

Linux / macOS：

```sh
curl --proto '=https' --tlsv1.2 -fsSL https://github.com/lexmount/moli/releases/latest/download/moli-installer.sh | sh
```

官方也发布 Windows 直接二进制，不想跑安装器就用它：

```powershell
# 从 releases 页挑与你的架构匹配的资产
curl.exe -L -o moli.zip https://github.com/lexmount/moli/releases/latest/download/moli-x86_64-pc-windows-msvc.zip
Expand-Archive moli.zip -DestinationPath "$env:LOCALAPPDATA\Moli" -Force
```

装完若位置不常规，把插件指过去：

```yaml
config:
  exePath: 'C:\path\to\moli.exe'
```

### 校验下载

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
`expectedSha256` 能强制校验你提供的摘要。它**不会**编造一个可信默认值——因为上游根本没有校验和可比。

## 三个设计要点

1. **输出走文件描述符，不走管道。** DSH 的 Windows 沙箱禁止子进程打开继承的命名管道，
   `spawnSync(..., { stdio: 'pipe' })` 会得到 `status=null` 与 0 字节。本项目始终把 stdout/stderr
   重定向到临时文件再读回。
2. **二进制按原始字节落盘。** PowerShell 的 `>` 会把原生程序输出按 UTF-16 重编码（每字节后插
   `00`），截图因此损坏。这里直接写字节，PNG 签名保持 `89504e470d0a1a0a`。
3. **零外部依赖。** profile 插件按磁盘真实路径加载（`link:` 依赖仍是符号链接目标），任何裸包名
   导入（例如 `@deepseek-ai/schemastery`）都会解析到插件目录而非 profile 的 `node_modules`，导致
   插件加载失败。本插件只导入 `node:` 内置模块和自己的文件。

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
        proxy: 'http://127.0.0.1:7890'                           # 转给本地正向代理
        insecureTls: true                                        # 见下方 TLS 说明
```

未设置 `exePath` 时探测顺序：`exePath` → 环境变量 `MOLI_BIN` → `%LOCALAPPDATA%\Moli\bin\moli.exe`
→ `%USERPROFILE%\.local\bin\moli.exe`。

## 安装

先装 Moli 本体——本插件只负责驱动它，不分发它。Windows 上：

```powershell
powershell -ExecutionPolicy ByPass -c "irm https://github.com/lexmount/moli/releases/latest/download/moli-installer.ps1 | iex"
```

（Linux/macOS 用对应的 `moli-installer.sh`，见 [Moli README](https://github.com/lexmount/moli#quick-start)。）

然后插件自身必须**同时**是 profile 依赖与已声明的 bundle，缺一个 loader 就看不到它：

1. 把本目录放到任意位置，例如 `D:\dsh_plugins\dsh-moli`。
2. 在该 profile 的 `package.json` 中加入：
   - `dependencies`: `"dsh-moli": "link:D:/dsh_plugins/dsh-moli"`
   - `dsh.profile.bundles`: `"dsh-moli"`
3. 在 profile 目录执行 `pnpm install`（生成 `node_modules/dsh-moli`）。
4. 重启 DSH。

注意：

- `dsh plugin --profile desktop …` 会被拒绝：desktop profile 归 Electron 应用所有。直接改它的
  `package.json`，或用应用内插件页（侧边栏 →**插件**→**添加插件**），那条路径同样走 pnpm。
- bundle 无法解析或未通过兼容性检查时，loader 会**静默跳过**，只在 stderr 留一行
  `skipping profile bundle …`。工具迟迟不出现时先找这行。

## 已知限制

- **面向 Windows。** 开发与验证都在 Windows 上；可执行文件探测、文件描述符绕坑、Schannel 说明都
  与 Windows 相关。移植到 POSIX 没有障碍，但未经验证。
- **不包含 Moli 本体。** 需自行安装，插件只负责定位和驱动它。
- **只封装了 `fetch`。** `moli serve`（CDP/WebDriver 服务器）与 `moli import`（会话导入）尚未做成工具。
- **不支持单次取消。** 引擎是同步执行的，被中断的回合无法中途终止抓取；已在进行的调用会跑完并
  写出产物。
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
  上报为 `possiblyUnreachable` 而不当作定论。

## 验证情况

在 Windows 上对 Moli 1.1.16 做了端到端验证：工具注册、probe、Markdown 与 JSON dump、`eval`
（含针对 `-t` 参数位置的紧超时回归防护）、PNG 与 PDF 产物签名、截断、全部拒绝路径（二元 dump 缺
`writeTo`、非法 `dump`、非法 `wait`、目标目录不存在）、失败分类（不可达主机、HTTP 状态、沙箱 TLS
阻断、吊销阻断）以及并发声明。被阻断主机的分类器用真实运行捕获的 stderr 文本做纯函数测试。

运行时也确认过：走本地代理抓取 JavaScript 渲染页面（GitHub 搜索）返回 14,560 字符 Markdown，
其中包含 30 处真实结果匹配。

## 许可

MIT，见 [LICENSE](LICENSE)。

Moli 本体也是 MIT（Copyright (c) 2026 Moli contributors）；本插件是独立的集成项目，与 Moli 项目无从属
或背书关系。
