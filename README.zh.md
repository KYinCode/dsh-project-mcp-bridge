# dsh-project-mcp-bridge

[English](README.md) | [中文](README.zh.md)

> **一句话**——让每个项目自己声明要用哪些 MCP 服务器。在项目根目录放一个
> `.dsh/mcp.json`，该项目的所有会话就有了这些服务器的工具
> （`mcp__<serverName>__<toolName>`），改文件**即时生效**——不用新开会话，
> 不用重启。
>
> 它是**客户端桥接插件**（消费 MCP 服务器）。不是 MCP 服务器，不是
> DeepSeek 官方包。

## 30 秒上手

```jsonc
// 你的项目/.dsh/mcp.json
{
  "mcpServers": {
    "github": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-github"],
      "env": { "GITHUB_TOKEN": "${GITHUB_TOKEN}" }
    }
  }
}
```

然后，在该项目打开的任何会话里，模型可以直接调用 `mcp__github__create_issue`
等工具——与 Claude Code、Cursor、VS Code 相同的 `mcpServers` JSON 结构。
以后再改这个文件，运行中的会话约 1 秒内就会跟上。

安装一次：`dsh plugin --profile web add dsh-project-mcp-bridge`（重启一次），
或见[安装](#安装)章节的免重启开发路径。

---

## 工作原理

```
agent 创建（agent/created）
  -> 读取 <会话 cwd>/.dsh/mcp.json
  -> 逐个服务器条目：
       - 若预设/宿主已有同名 serverName 且条目未设 "override": true
         -> 跳过（日志说明原因）
       - 否则做一次性 SCHEMA 同步：连接（stdio spawn 或
         streamable-http）+ 列出工具 + 以 mcp__<serverName>__<rawName>
         注册进 AGENT 层（仅该项目会话可见，优先级：项目 > 预设 > 宿主）
         + 随即关闭
  -> 不保留任何连接：空闲会话不占用任何子进程

第一次调用某服务器的工具（execute）
  -> 该 agent 的 controller 检查自己的按服务器连接
  -> 没有 -> 懒连接（日志提示 "connecting..."；这就是首次调用延迟）-> 调用
  -> 每次调用都重置一个按连接的空闲计时器（默认 5 分钟）；
     到时关闭连接、释放子进程；下次调用自动重连，对模型透明
  -> 连接意外死亡（onclose）-> 本 agent 丢弃死连接，下次调用重连
     ——无广播、无共享状态
```

连接是**每 agent 独占、绝不池化**：N 个会话调用同一服务器 = N 个独立
进程（隔离优先于共享）。从不调用某服务器的会话不占用任何进程。

## 安装

本包是 **profile bundle**：用 dsh CLI 安装，无需手动改任何配置文件。

```bash
dsh plugin --profile web add dsh-project-mcp-bridge
```

`dsh plugin` 会在 profile 目录运行 pnpm，然后自动核对
`dsh.profile.bundles`：本包声明了 `dsh.bundle.patch`，会自动加入 profile
的 bundle 层。插件行由包自带的 `cordis.patch.yml` 提供——**不需要手写任何
行**。

**装完重启一次 `dsh web`**：bundle 层在启动时组合（只有用户补丁层和
`settings.yaml` 是热重载的）。重启之后，`.dsh/mcp.json` 的修改全部热生效
（见"配置热重载"）。

### 免重启开发路径（热安装）

如果你要反复改这个插件本身、希望改动**不重启就生效**，可以用**用户补丁
行**安装（而不是 bundle）。行内用**包名**引用（从 profile 的
`node_modules` 解析），可移植且热：

```bash
cd ~/.dsh/profiles/web
pnpm add dsh-project-mcp-bridge          # 装进 node_modules（不触发 reconcile）
```

然后在 `~/.dsh/profiles/web/cordis.patch.yml` 追加：

```yaml
- insert:
    - id: dsh-project-mcp-bridge
      name: 'dsh-project-mcp-bridge'     # 包名，不是 file:// 路径
```

用户补丁层热重载（约 4 秒），行会**无需重启**生效。注意：此路径**不要用**
`dsh plugin add`——那会同时注册 bundle，下次重启后产生重复行。日常使用
推荐 bundle 安装；此路径仅用于本机迭代。

## 项目配置

在项目根目录创建 `.dsh/mcp.json`（文件存在即 opt-in；没有该文件的项目
不受影响）：

```json
{
  "mcpServers": {
    "github": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-github"],
      "env": { "GITHUB_TOKEN": "${GITHUB_TOKEN}" },
      "idleTimeoutMs": 300000
    },
    "local-api": {
      "url": "http://localhost:3000/mcp",
      "headers": { "Authorization": "Bearer ${MCP_TOKEN}" },
      "override": true
    }
  }
}
```

### 字段（与 dsh-mcp-client 同名）

| 字段 | 传输 | 必填 | 含义 |
|---|---|---|---|
| `transport` | 两者 | — | 推断：有 `command` → stdio；有 `url` → streamable-http；两者恰好其一 |
| `serverName` | 两者 | 是 | 工具命名空间（即 JSON 键）；`[A-Za-z0-9_-]{1,32}` |
| `command` | stdio | 是 | 要 spawn 的可执行文件 |
| `args` | stdio | 否 | 参数 |
| `env` | stdio | 否 | 额外环境变量，合并到清理后的父环境之上 |
| `cwd` | stdio | 否 | 子进程工作目录（相对路径以项目根为基准） |
| `url` | http | 是 | MCP 服务器 URL |
| `headers` | http | 否 | 额外请求头 |
| `toolCallTimeoutMs` | 两者 | 否 | 单次调用超时（默认 60000） |
| `idleTimeoutMs` | 两者 | 否 | 空闲断开：连续这么多毫秒无调用即断开（默认 300000 = 5 分钟；`0` = 永不空闲断开） |
| `override` | 两者 | 否 | 即使预设/宿主已提供同名 serverName，也强制使用项目连接（默认 false） |

`env`/`headers` 值中的 `${NAME}` 占位符从宿主进程环境展开。

## 与预设/宿主级 MCP 的冲突语义

- 工具注册在 **agent 层**；分层注册表使同名工具遮蔽预设层与全局层——
  可见性优先级 **项目 > 预设 > 宿主**。
- 预设/宿主已提供的 `serverName` **默认跳过**（每个 agent 对该服务只建一份
  连接）；设置 `"override": true` 强制使用项目连接（接受双连接，项目版胜出）。
- **override 不会关掉上层**：项目连接是**叠加**上去的——上层（宿主/预设）
  连接照常存活；agent 层的项目副本遮蔽同名工具（分层注册表），模型实际
  调用的是项目连接。工具名不携带来源标记——插件在 override 覆盖了既有
  上层注册时，日志会写明
  `shadows upper-layer registration(s); upper connections stay alive`；
  进程数量是另一个验证手段。
- 不同 serverName / 不同工具名天然共存。
- **注意——两种桥，两种哲学**：官方 `dsh-mcp-client` 实例之间（宿主行、
  预设行）同名 `serverName` 是**进程级唯一**，重复会导致**挂载失败**
  （"pick a unique serverName"）——官方桥宁可用失败暴露配置错误，也不用
  静默遮蔽。本插件的项目配置与上层同名时**默认跳过**，保证项目会话仍能
  创建。实际含义：项目 vs 宿主/预设重复 → 跳过（本插件）；预设 vs 宿主
  在 `dsh-mcp-client` 行之间重复 → 必须改名。

## 配置热重载

保存 `.dsh/mcp.json` 会为该项目所有**运行中**的会话重新解析并**全量重建**
每个会话的项目 MCP 表面：

- **新增服务器** → schema 同步 + 注册工具（运行中会话即时获得）
- **删除服务器** → 注销工具 + 关闭其连接
- **修改服务器** → 全量重建——注销全部、关闭全部连接、重读、重新注册。
  不做指纹比较：改了就是重建。serverName 不变则公开工具名稳定，历史工具
  调用可重放
- **删除配置文件** → 该项目的全部 MCP 工具卸载

无需新开会话。文件通过 `fs.watchFile` 轮询（约 500ms）+ 300ms 防抖检测，
并广播给该项目所有存活会话。被重配的服务器上正在执行的调用可能在重建
瞬间被中断。

**连接死亡（v4）**：服务器的进程若死亡，SDK 的 `onclose` 触发，该 agent
丢弃死连接；**下一次调用自动重连**（懒）——无需重启、无需新会话、无需
改配置。每个 agent 自管：无广播，一个会话里的死亡从不打扰另一个会话。
重连失败会以工具错误的形式浮现，下次调用再试。注意：重连后，服务器自身
的**内部依赖**（如浏览器连接）可能还需数秒就绪——该窗口内的调用可能以
服务器自己的错误失败；这是服务器行为，不是桥的缺陷。

**空闲断开**：连续 `idleTimeoutMs` 毫秒无调用即断开连接（默认 5 分钟；
按服务器配置，`0` = 永不）。空闲会话不占子进程；下次调用自动重连
（仅多一次延迟）。

**懒连接须知**：工具 schema 只存在于服务器上，所以会话创建时每个被接受
的服务器会做一次短暂的 schema 同步（连接 + 列工具 + 注册 + 关闭）。从不
调用的服务器也只付出这一次短暂 spawn；之后不保留连接。若创建时 schema
同步失败（服务器没起来），该服务器的工具不会注册，直到下次配置变化或
新开会话。

## 环境变量降权

MCP 子进程使用官方 `scrubbedParentEnv()` 清理后的环境：剔除凭据形态的
变量名（匹配 `KEY|PASSWORD|SECRET|TOKEN`）与陈旧的 `DSH_*` 变量。
`PATH`、`HOME` 和区域设置保留，子进程正常运行；宿主环境里碰巧存在的
密钥**不会被继承**，只有条目显式声明的 `env` 会加回。这不是沙箱：恶意
配置仍能以你的用户身份执行代码、读取你的文件（见信任模型）。

## 信任模型 ⚠️

`.dsh/mcp.json` 是**可执行内容**——信任模型与 `package.json` 的 scripts
完全相同。`git clone` 的仓库可以自带 `.dsh/mcp.json`（正如可以自带恶意
`postinstall`），打开项目并创建会话时它就会执行。只打开你信任来源的
项目。插件缩小了爆炸半径（清理环境、可审计日志），但无法也不能让不
可信项目变安全。

## 日志

- `ctx.logger`（宿主 stdout——本部署不落盘）
- `~/.dsh/logs/dsh-project-mcp-bridge/dsh-project-mcp-bridge.log`
  （追加式；每个环节——配置读取、跳过原因、连接、工具注册、关闭——
  都带时间戳与项目路径记录）

## 已知限制

- 只桥接工具能力：MCP 的 resources 与 prompts 不支持。
- 连接是**每 agent 独占、绝不池化**：N 个会话调用同一服务器 = N 个进程。
  重服务器（如 chrome-devtools）每个活跃会话占一个进程——空闲超时让
  不用的进程很快释放。会话创建时每个服务器还会付一次短暂的 schema 同步
  spawn。
- 不支持 MCP 的流式/任务型执行（仅普通 call）。

## 延伸阅读

- [设计笔记：DSH 的哲学与本插件的对齐](docs/design-notes.zh.md) ·
  [Design notes (English)](docs/design-notes.md) —— DSH 为什么这样分层、
  它的信任模型、热加载边界，以及"项目级 MCP 为什么是插件的活"。
