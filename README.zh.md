# dsh-project-mcp-bridge

宿主平面 DSH 插件：**按项目加载 MCP 服务器**。在项目根目录放一个
`.dsh/mcp.json`（与 Claude Code、Cursor、VS Code 共享的 `mcpServers` JSON
结构），该项目的会话自动获得这些服务器的工具，名为
`mcp__<serverName>__<rawName>`。

这是一个**客户端桥接插件**——它消费 MCP 服务器。它不是 MCP 服务器，也
不是 DeepSeek 官方包。

---

## 工作原理

```
agent 创建（agent/created）
  -> 读取 <会话 cwd>/.dsh/mcp.json
  -> 逐个服务器条目：
       - 若预设/宿主已有同名 serverName 且条目未设 "override": true
         -> 跳过（日志说明原因）
       - 否则连接（stdio spawn 或 streamable-http）
       - 列出工具，以 mcp__<serverName>__<rawName> 注册进
         AGENT 层（仅该项目会话可见，优先级：项目 > 预设 > 宿主）
  -> 连接按 (项目根, serverName) 池化共享；最后一个会话释放时关闭
```

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

## 项目配置

在项目根目录创建 `.dsh/mcp.json`（文件存在即 opt-in；没有该文件的项目
不受影响）：

```json
{
  "mcpServers": {
    "github": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-github"],
      "env": { "GITHUB_TOKEN": "${GITHUB_TOKEN}" }
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
| `override` | 两者 | 否 | 即使预设/宿主已提供同名 serverName，也强制使用项目连接（默认 false） |

`env`/`headers` 值中的 `${NAME}` 占位符从宿主进程环境展开。

## 与预设/宿主级 MCP 的冲突语义

- 工具注册在 **agent 层**；分层注册表使同名工具遮蔽预设层与全局层——
  可见性优先级 **项目 > 预设 > 宿主**。
- 预设/宿主已提供的 `serverName` **默认跳过**（同一服务保持一份连接）；
  设置 `"override": true` 强制使用项目连接（接受双连接，项目版胜出）。
- 不同 serverName / 不同工具名天然共存。

## 配置热重载（v2）

保存 `.dsh/mcp.json` 会为该项目所有**运行中**的会话重新解析并做世代替换：

- **新增服务器** → 连接 + 注册工具（运行中会话即时获得）
- **删除服务器** → 注销工具 + 释放池化连接
- **修改服务器** → 注销旧世代 → 连接新世代——serverName 不变则公开工具名
  稳定，历史工具调用可重放
- **删除配置文件** → 该项目的全部 MCP 工具卸载

无需新开会话。文件通过 `fs.watchFile` 轮询（约 500ms）+ 300ms 防抖检测；
重连按服务器独立进行，被重配的服务器上正在执行的调用可能在切换瞬间被
中断。

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
- 连接按 (项目根, serverName) 池化共享；同一项目多个会话共用一份连接，
  最后一个会话释放时关闭。
- 不支持 MCP 的流式/任务型执行（仅普通 call）。
