# DSH 设计哲学与本插件的对齐（Design notes）

> 本文是社区观察，基于对 DSH（deepseek-harness）源码与文档的阅读整理，
> 非官方文档。目的是解释"DSH 为什么这样设计"以及"本插件为什么是现在
> 这个样子"，帮助读者理解取舍，而不是抱怨边界。

## 1. 一切皆插件：两个平面

DSH 的组装（composition）分成两个平面：

| 平面 | 内容 | 生命周期 |
|---|---|---|
| **宿主组装**（host composition） | 注册表（tools/agents/skills）、沙箱与审批栈、持久化、模型路由、子代理注册表 | 进程级，一份 |
| **agent 预设**（agent preset） | 一个会话的能力面：工具行、persona、提示词段落、技能 | 随会话挂载/卸载 |

工具注册表按 **scope 三层**分层：`agent → preset → global`，**近者遮蔽远者**。
这是"项目 > 预设 > 宿主"可见性优先级的机制来源——本插件把 MCP 工具注册进
**agent 层**，正是尊重这一分层：项目配置只影响它自己的会话，不污染全局。

## 2. 信任模型：能力 = 信任

- **preset 就是组装**：一个 `user` 预设的权限恰好等于它引用的插件——与
  shell 访问同级。`trust: system`（随附只读）与 `trust: user`（可写）的
  区分用于呈现，不用于隔离。
- **项目目录是"内容区"，不是"信任区"**：DSH 允许项目放 `.dsh/skills`、
  `.agents/skills`、`AGENTS.md`——全是**提示词文本**（模型可斟酌、可拒）。
  项目目录**没有**可执行配置的官方入口。
- **推论**：项目级 MCP（`command`/`env` 会 spawn 进程）是"可执行配置"，
  与 `package.json` scripts 同级信任——官方不内置它，最可能的理由正是
  不替用户做这个信任陈述。预设是官方给出的"项目能力面"答案：能力绑定
  显式选择，而不是绑定"打开目录"这个无意识动作。
- **本插件的对齐**：`.dsh/mcp.json` 是 **opt-in 文件**（存在才加载）；
  子进程用官方 `scrubbedParentEnv()` **降权**（凭据形态变量不继承）；
  每个动作写**可审计日志**；README 明确声明"与 package.json scripts
  同级信任"——缩小爆炸半径，但不假装能防供应链攻击。

## 3. 热加载边界：什么热，什么冷，为什么

| 层 | 变化 | 热？ | 机制 |
|---|---|---|---|
| `settings.yaml` | 用户设置 | ✅ | base 组装的 hot-reload 文档 |
| 用户补丁层（`cordis.patch.yml`） | 加/改/删行 | ✅ ~4s | `watchUserPatches` → `hmr.registerConfig` → include `entry.update` |
| 动态插件 | 定义/激活/卸载 | ✅ 全热 | `cordis_run`/`cordis_stop`（进程内存） |
| `.dsh/mcp.json` | 项目配置 | ✅ ~1s | 本插件的 `fs.watchFile` + 世代替换 |
| **bundle 列表**（`dsh.profile.bundles`） | `dsh plugin add/remove` | ❌ **重启** | 启动时 `composeProfile` 组合，无 watcher |

**哲学解释**：DSH 热的是**已装配内容的变化**，冷的是**装配本身的变更**。
装配变更（装一个带 94 个新依赖的包）如果热应用，中途失败的回滚与诊断
复杂度远高于启动时 fail-loud 审计（例如 `must be a top-level YAML array`
——启动即点名）。按"高频操作热、低频操作冷"分配，是工程取舍，不是理念
背叛；"一切皆插件"承诺的是能力边界的插件化，不是装配本身的热。

**行业常态**：VS Code 装扩展要"重新加载窗口"，浏览器装扩展要重启，
Claude Code 装 MCP server 要重开会话——"新包的安装要重载"是全行业常态；
"已装内容的启停"才是热插拔的承诺对象（DSH 通过动态插件完整兑现）。

## 4. 为什么项目级 MCP 要由插件实现（而不是官方内置）

1. **信任边界**：可执行配置不该落在"打开即执行"的位置（见第 2 节）。
2. **官方扩展点就是插件**：DSH 的一切能力都是插件行——实现一个"项目级
   MCP 加载器"插件，是官方认可的做法，且不破坏任何分层。
3. **风险自担的诚实**：插件作者替用户做了信任陈述，所以必须把降权、
   审计、文档声明做齐（本插件的三个对齐措施）。

## 5. 本插件的已知边界

- **bundle 安装需重启一次**：`dsh plugin add` 改的是 bundle 列表（冷层），
  这是 DSH 机制，不是插件缺陷；本机迭代可用"用户补丁行 + 包名"热安装
  （见 README「免重启开发路径」）。
- **只桥接工具**：MCP 的 resources/prompts 没有消费接口。
- **不支持任务式执行**：仅普通 call（与官方 `dsh-mcp-client` 一致）。
- **连接池共享状态**：同一项目多会话共用连接，有状态服务器会看到同一份
  状态。

## 6. 一个值得上游推进的方向

`dsh.profile.bundles` 目前无 watcher（HMR 只监听补丁文件）。技术上可以
复用同一套 include 机制：监听 package.json → 重新 compose → `entry.update`，
让 `dsh plugin add` 也免重启。详见 `../dsh-hot-installer/idea.md`。
