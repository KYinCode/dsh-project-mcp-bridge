# dsh-project-mcp-bridge v4 设计（架构重构）

> 状态：设计完成，待新会话实现。
> 目标：去掉连接池，改为"每 agent 独立连接 + 懒连接 + 空闲超时"，
> 代码 ~630 → ~380 行，消除共享管理复杂度（池、广播、竞态）。

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
