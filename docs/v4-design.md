# dsh-project-mcp-bridge v4 设计（架构重构）

> 状态：**已实现（0.2.0）**。实现记录见文末「实现记录（0.2.0）」。
> 目标：去掉连接池，改为"每 agent 独立连接 + 懒连接 + 空闲超时"，
> 消除共享管理复杂度（池、广播、竞态）。

## 为什么重构（背景）

现状（0.1.11，池化）有三个问题：

1. **并发风险**：多会话共享一条连接 → 搜索/查询类 MCP 服务器上可能出现
   排队、竞争或拒绝（服务器行为不可知）。主流 harness（Claude Code/
   OpenCode）选择"共享 + 信任协议并发"，但本插件的核心价值是会话级
   隔离（scope 分层），连接级隔离是同一哲学的延伸。
2. **无条件常驻**：会话一创建就拉起 MCP 子进程，不用也常驻到会话销毁。
3. **共享管理复杂度**：poolPromises/poolRefs/指纹 key/引用计数 +
   supervisor 广播 + record.dead 竞态——只服务于"省进程"，收益有限。

参照：Claude Code 常驻被社区吐槽（懒连接 issue 未解决）；OpenCode 有
idle-timeout 和 auto-reconnect（与我们要做的方向一致）。

## 新架构（v4）

```
会话创建（agent/created）
  → 读 .dsh/mcp.json → 注册工具 schema（【不连接】）
  → 每个 agent 一个 controller：{ serverName -> { client, transport, idleTimer } }

第一次调用某服务器的工具（execute）
  → controller 检查该 server 是否已连接
  → 未连接 → 现场连接（懒）：createTransport + client.connect + listTools
     （工具 schema 已预先注册，这里只建立底层连接）
  → 调用

空闲超时（默认 5 分钟，可配）
  → 每次调用刷新 idleTimer
  → 超时 → 主动断开（client.close + transport close）→ 释放进程
  → 再次调用时重新连接（懒）

连接意外死亡（client.onclose，PoC 已验证 Windows 可靠触发）
  → 本 controller 标记 dead → 下一次调用时重连（或立即重建）
  → 【无广播、无 record.dead 竞态——每个 agent 自管】

会话销毁（agent/disposed）
  → 断开所有连接 + 清理 timer
```

## 关键设计决策

| 决策 | 理由 |
|---|---|
| **去池化** | 每 agent 独占连接 → 并发/状态完全隔离，不赌服务器；无共享 → 无广播无竞态 |
| **懒连接** | 不用的会话不占进程；首次调用有连接延迟（可接受，日志提示） |
| **空闲超时断开** | 长空闲不占进程；再次调用自动重连（对模型透明，仅延迟） |
| **工具 schema 预先注册** | 模型必须先看到工具列表才能调用——懒只能懒"连接"，不能懒"注册" |
| **保留热重载** | watchFile 仍监听 mcp.json；变化 → 本 controller 全量重建（不比较指纹，简化） |
| **保留 skip/override** | hasServerTools 检测上层已有 → skip；override → 强制本会话连接 |
| **保留降权 + 日志** | scrubbedParentEnv + 文件日志（不变） |

## 与现状的差异（实现对照）

| 组件 | 现状（池化） | v4（独立） |
|---|---|---|
| poolPromises/poolRefs | 保留 | **删除** |
| 指纹 key（连接粒度） | projectRoot+serverName+fp | **删除**（每 agent 自然唯一） |
| supervisor 广播 | onclose → 遍历所有会话 reload | **删除**（onclose → 本 controller 标记 dead） |
| record.dead 竞态修复 | 保留 | **天然消失**（无共享） |
| 热重载 diff | 指纹比较 + 世代替换 | 简化：配置变化 → 本 controller 断开全部 + 重读 + 重新注册 |
| execute | 直接 callTool | 增加"检查连接，未连则 connect"前置 |
| 空闲管理 | 无 | **新增**：timer 刷新 + 超时断开 |
| 多会话同 MCP | 1 进程（共享） | N 进程（各连各的） |

## 配置新增

```jsonc
// .dsh/mcp.json 每 server 可选字段（v4 新增）
{
  "mcpServers": {
    "search": {
      "command": "...",
      "idleTimeoutMs": 300000   // 默认 5 分钟；0 = 永不空闲断开
    }
  }
}
```

## 测试计划（新会话必做）

1. **懒连接**：开会话 → 无进程；调用一次 → 进程出现
2. **空闲断开**：调用后等 idleTimeout → 进程消失；再调用 → 重新连接成功
3. **并发隔离**：两个会话同时调用同一 MCP → 两个独立进程、互不干扰
4. **重连（kill）**：kill 进程 → onclose → 下次调用自动重连
5. **热重载**：改 mcp.json → 本会话工具集更新（全量重建）
6. **冲突语义**：skip / override 行为不变
7. **多会话对比**：验证 2 个会话各自独立连接（进程数 = 会话数）

## 风险与权衡（诚实说明）

- **多会话多进程**：同时 N 个会话调用同一 MCP = N 个进程；重服务器
  （chrome-devtools）多开会明显——用空闲超时兜底（不调用就断）
- **首次调用延迟**：懒连接使第一次调用有连接耗时（npx 冷启动数秒），
  日志提示"connecting..."
- **协议并发不再共享**：这是特性不是缺陷（每个会话独占）

## 环境事实（继承自前会话，直接可用）

- profile：`~/.dsh/profiles/web/`；插件日志：`~/.dsh/logs/<名>/<名>.log`
- 开发迭代：patch 行 file:// + ?v=N（ESM 缓存坑）；发布：bundle 流程
- 发布流程：`npm version patch; npm publish; git push;
  dsh plugin --profile web update; 重启`
- git 身份（仓库级）：name=`KYinCode`，email=`104397972+KYinCode@users.noreply.github.com`
- npm granular token 已配（bypass 2FA）；git 代理 `http://127.0.0.1:7897`
- 参考代码：现有 `index.mjs`（0.1.11，保留 skip/override/降权/热重载骨架）

## 实现记录（0.2.0）

新会话实现完成，按测试计划全部通过。实现与原设计的三处差异，如实记录：

1. **schema 同步需要一次短暂连接（设计图里的【不连接】不可行）**。工具
   schema 只存在于服务器上（listTools 返回），配置里没有；而注册又不能懒
   （模型必须先看到工具列表）。因此"注册工具 schema"被实现为**一次性
   schema 同步**：connect + listTools + register + close，注册完立即断开。
   会话创建后**不保留任何连接**——"开会话 → 无进程"在稳态成立（测试 1
   即按稳态断言）。代价：每个被接受的服务器在会话创建时付一次短暂 spawn；
   从不调用的服务器也只付这一次。测试 1 通过。
2. **懒连接路径仍执行 listTools**（按设计流程图原文），仅作连接校验，不
   重新注册。execution 前置 = `ensureConnected`：有连接直接用；无连接则
   并发调用共享同一个 in-flight connect（同一 agent 内两个并行调用不会
   开出两个进程）。
3. **行数没到 ~380**。0.1.11 = 639 行（逻辑 476）；0.2.0 = 660 行（逻辑
   505）。池机制删除省了约 150 行，但空闲管理（armIdle/clearIdle/busy
   计数防中途掐断/连接去重）新增约 40 行，且注册/热重载/配置校验等基础
   设施（约 350 行）必须保留——原估计未计入这部分。架构复杂度才是目标：
   池、广播、指纹、record.dead 竞态**全部消失**。

其余决策与设计完全一致：每 agent 独占连接（无池无广播）、空闲超时断开 +
   下次调用懒重连、onclose → 本 controller 标记 dead、热重载全量重建
   （无指纹比较）、skip/override 不变、scrubbedParentEnv + 文件日志不变。

## 测试记录（0.2.0，全部通过）

按测试计划逐项验证，用两种方式：**脚本化集成测试**（`_integ-v4.mjs`——
   用假 Cordis/agent 上下文驱动真实插件代码路径 + 真实 test-server 子进程，
   以子进程自报 PID 计数）与**线上 harness 实测**（本机 web profile 的 dev
   patch 行 + 子会话）。

| # | 计划项 | 结果 |
|---|---|---|
| 1 | 懒连接：开会话 → 无进程；调用一次 → 进程出现 | ✅ 集成测试 + 线上实测（`connecting...` → `connected` → 返回结果） |
| 2 | 空闲断开：调用后等 idleTimeout → 进程消失；再调用 → 重连成功 | ✅ 4000ms 配置实测，断开后自动重连 |
| 3 | 并发隔离：两会话同时调用同一 MCP → 两个独立进程 | ✅ 集成测试 live=2；并行首次调用共享同一连接（去重）也通过 |
| 4 | 重连（kill）：kill 进程 → onclose → 下次调用自动重连 | ✅ SIGKILL 实测，onclose 日志 + 自动重连 |
| 5 | 热重载：改 mcp.json → 本会话工具集更新（全量重建） | ✅ 新增服务器、清空配置、删除配置文件三种情况 |
| 6 | 冲突语义：skip / override 行为不变 | ✅ 全局层 + 预设层双实测（见下） |
| 7 | 多会话对比：进程数 = 会话数 | ✅ 两 agent 各持一进程，空闲后全部释放 |

### 冲突语义实测（全局层 + 预设层）与 0.2.1 修复

测试计划第 6 项在真实 harness 里分两层验证：

- **全局层**：profile patch 插入官方 `dsh-mcp-client` 行（serverName `test`）→
  项目会话 skip（`already provided by preset/host MCP — skipped`）；加
  `override: true` → 强制注册 + shadows 日志。✅
- **预设层**：`~/.dsh/.agent-presets/v4-mcp-test/` 预设（内含 mcp-client 行，
  serverName `testp`），设置默认预设后新会话挂载 → 期望 skip。**首次实测
  失败**：testp 照常注册。排查发现这是从 v3 沿用至今的**实现缺陷**：
  `hasServerTools` 调用 `tools.schemas()`（无参）——dsh-tools 的注释明确
  无参 = **全局视图**（global view），只含 host 组合层；**预设层注册在
  agent 的可见链上，全局视图看不到**。全局层冲突恰好可见（所以旧测试
  从未暴露），预设层冲突永远检测不到 → 项目重复注册（agent 层遮蔽预设层）。
  修复（0.2.1）：`hasServerTools` 改传 agent 视角
  `tools.schemas(state.agent)`（与 dsh-tool-cordis 等宿主调用一致），
  覆盖完整可见链（agent + 预设 + 全局）。修复后重测：testp skip ✅、
  全局层 test skip ✅（回归）、override 强制 ✅。测试期间另确认：预设的
  mcp-client 是 eager 常驻连接（官方桥设计，无空闲超时），与本插件懒连接
  形成对照。

额外发现并修复的两个问题（均记入代码注释）：

- **插件 HMR 后残留旧实例控制器**（v3 时代就存在）：模块级 controller 状态
  在 ctx dispose 后继续存活（旧实例仍 watch 配置、持有连接）。v4 在
  apply() 里注册 `ctx.effect` 清理：插件卸载时 teardown 所有 controller。
- **dispose 与 in-flight schema sync 的竞态**：会话销毁时 setup 还在进行
  → 注册的工具泄漏。setupServer 在 sync 完成后检查 `state.disposed`，
  丢弃并注销。

另一个线上观测（非插件缺陷）：子会话首轮的工具目录快照先于异步注册完成，
  模型首轮看不到 MCP 工具（v3 同样如此；GUI 长会话在第二轮起可见）。
