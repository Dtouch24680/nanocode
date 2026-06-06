# nanocode → Claude Agent SDK 迁移方案

> 版本: v2.0 | 日期: 2026-06-06 | 作者: Sonnet 调研 → Codex 对抗审核 → v2 整合
> 变更摘要见同目录 CHANGELOG.md

---

## 一、现状评估

### 当前架构

nanocode 当前以 **wrap `claude --print` CLI** 的方式驱动 Claude 会话。架构图：

```
Browser → WebSocket/HTTP → Node.js Express Server
                                  ↓
                         claude-session-controller.js
                                  ↓
                    spawn('claude', ['--print', '--output-format=stream-json', ...])
                                  ↓
                         手工 parse JSONL stream
                         手工 dedup replay_id
                         手工 queue / busy / lock
                         手工 /resume 拦截翻译
                         手工 parse ~/.claude/*.jsonl 读历史
```

### 核心胶水代码行数统计

| 文件 | 行数 | 职责 |
|---|---|---|
| `terminal/claude-session-controller.js` | 571 | spawn / stream-json / queue / interrupt / /resume 拦截 |
| `terminal/claude-history.js` | 317 | parse ~/.claude/*.jsonl / dedup / replay |
| `terminal/routes.js` | 491 | HTTP API / WS 路由（含大量 session 状态管理） |
| `terminal/sessions.js` | 398 | session 持久化 / GC / 在 FS 上索引 jsonl |
| **合计（核心胶水）** | **~1777 行** | |

### 已知架构债

1. **/resume 拦截**：CLI 非交互模式不支持 /resume，在 session-controller 里拦截并重写成 `--resume` 参数（保留到 parity 存在后才能删）
2. **stream-json dedup**：CLI 在 reconnect/replay 时会重放历史 event，自己维护 `replay_id` Map 去重
3. **session lock/queue**：CLI spawn 是串行的，queue 提供即时反馈 + 批量合并 + interrupt 清队列（是 design，不是 dead code）
4. **jsonl parse**：自己读 `~/.claude/projects/.../...jsonl` 还原历史（317行）
5. **interrupt**：向 spawn 进程发 SIGINT，然后手动 drain，容易有 race condition
6. **auth status**：`execFile('claude', ['auth', 'status', '--json'])` 轮询

---

## 二、SDK 概览

### Package

```
npm install @anthropic-ai/claude-agent-sdk
```

- **npm package**: `@anthropic-ai/claude-agent-sdk`（前身 `@anthropic-ai/claude-code`）
- **当前版本**: 0.3.165（2026-06）
- **Node.js 要求**: 18+
- SDK **自带捆绑的 claude 二进制**（不是系统路径的 claude，SDK 内部 findCodexPath() 优先 bundled binary）

### 认证方式

SDK 继承 Claude Code CLI 的认证栈，优先级从高到低：

| 优先级 | 方法 | 适用场景 |
|---|---|---|
| 1 | `ANTHROPIC_API_KEY` env | API key 计费（Console 账号） |
| 2 | `CLAUDE_CODE_OAUTH_TOKEN` env | CI/脚本，`claude setup-token` 生成一年有效 OAuth token |
| 3 | OAuth `/login` 会话凭证 | 交互登录（Team/Enterprise 订阅） |
| 4 | Cloud provider（Bedrock/Vertex/Azure） | 企业部署 |

**已验证（B1 smoke）**：SDK 在无 `ANTHROPIC_API_KEY` / `ANTHROPIC_AUTH_TOKEN` / `CLAUDE_CODE_OAUTH_TOKEN` 的条件下，成功读取 `~/.claude/.credentials.json`，`accountInfo()` 返回 `subscriptionType: "Claude Team", apiProvider: "firstParty"`。

**限制（codex review 必修#6）**：OAuth 凭证复用仅适用于本地/内部使用的 nanocode wrapper。官方文档明确指出第三方开发者不应在未经授权的产品中使用 `claude.ai` 登录路径。如未来有外部分发需求，需切换为 API key 计费。

### 计费（Team 订阅，codex review 必修#2）

主人账号为 **Claude Team**（`claude auth status --json` 已确认）。从 2026-06-15 起，Agent SDK 和 `claude -p` 用量从互动额度独立出来：

| 订阅层级 | SDK Credit | 说明 |
|---|---|---|
| Team Standard | $20/seat/月 | 每用户独立，不 pooled |
| Team Premium | $100/seat/月 | 每用户独立，不 pooled |

- Credit 用完后：若未启用 usage credits，**请求停止**（不降级）；若启用，转向 usage credits 计费
- Credit 是 **per-user、non-pooled**，多用户环境每人各自消耗
- 上线前需确认本 seat 是 Team Standard 还是 Team Premium，并确认 usage credits 是否开启

### 核心 API

```typescript
import { query, listSessions, getSessionMessages } from "@anthropic-ai/claude-agent-sdk";

// 发一条消息，流式接收
for await (const message of query({
  prompt: "你好",
  options: {
    model: "claude-opus-4-7",
    maxTurns: 10,
    effort: "high",
    thinking: { type: "enabled", maxThinkingTokens: 10000 },
    permissionMode: "acceptEdits",
    systemPrompt: { type: "preset", preset: "claude_code" },
  }
})) {
  console.log(message);
}
```

---

## 三、现有 Feature 迁移对照表

| Feature | 当前实现 | SDK 等价 | 迁移风险 | 工作量 |
|---|---|---|---|---|
| **spawn Claude 进程** | `spawn('claude', ['--print', '--output-format=stream-json'])` | `query({prompt, options})` | 低 | XS |
| **stream-json 接收** | 手工 readline + JSON.parse | async generator（原生） | 低 | XS |
| **stream dedup** | 自维护 `replay_id` Map | SDK 内置，无需 dedup | 低，可删 317 行 | XS（删代码） |
| **session 历史加载** | 手工 parse `~/.claude/*.jsonl` | `listSessions()` / `getSessionMessages()` / `resume: sessionId` | **中：output shape 不同，需适配层**（B1 smoke 已证 `getSessionMessages` 返回 normalized user/assistant，与 replay-event history 格式不一致） | M（Phase D 独立） |
| **session resume** | `--resume=<id>` CLI arg | `options.resume = sessionId` | 低，已验证同 cwd 可用 | XS |
| **cross-dir resume** | `--resume=<id>` CLI arg | `options.resume = sessionId` | **高：B1 smoke 全失败**，需保留 cwd-aware session 映射 | M |
| **/resume 拦截** | 检测用户输入 `/resume` 并重写 | 原生支持 session id，但 nanocode 拦截逻辑含 recent-session 选择 / project scope | **中：保留到 parity 存在**（recent-session 选择语义不等同于 `options.resume`） | Phase D |
| **/continue 拦截** | 类似 /resume | `options.continue = true`（cwd-scoped 取最近 session） | 低，行为已验证 | XS |
| **busy/queue** | 自维护 `busy` flag + `queue` 数组 | **保留**：queue 提供即时反馈、批量合并 turn、interrupt 后清队列，是 design work 不是 dead code | **中，需 redesign 不是 deletion**（参见 codex review 必修#3） | M（Phase C） |
| **interrupt** | SIGINT 到子进程 | `query.interrupt()` 调用存在，但 smoke 证实返回 `error_during_execution` 而非 `interrupted` subtype，需 adapter 归一化 | **高（codex review 必修#1）：不是 drop-in，移到 Phase C 专项** | M（Phase C） |
| **session lock GC** | 轮询 PID 是否存活 | SDK 无需此机制 | 低，可删 | XS（删代码） |
| **active-session-guard** | 服务器端 busy flag + active-session 碰撞检查 | **保留**：多客户端共享 session、late joiner replay、active session 碰撞 guard 都仍需 server 层协调（codex review 必修#3） | 中，重设计 | M（Phase C） |
| **permission_mode** | 前端下拉 → CLI arg | `options.permissionMode` | 低 | S |
| **model 下拉** | CLI arg `--model` | `options.model` | 低 | XS |
| **effort 下拉** | CLI arg `--effort` | `options.effort` | 低 | XS |
| **thinking blocks** | event schema `thinking` type 渲染 | **中（B1 smoke 发现 thinking 漂移）**：SDK 在 thinking prompt 下未输出 thinking block，并给出错误答案，需专门的 B2.5 验证门禁 | **高（Phase B2.5 独立验证）** | M |
| **tool_use 渲染** | 解析 `tool_use` event | SDK emit 相同 content block（B1 tool parity 已验证） | 低，schema 兼容 | S（验证 schema） |
| **auth status 检查** | `execFile('claude', ['auth', 'status'])` | `query.accountInfo()` | 低 | XS |
| **slash commands 列表** | 硬编码 | `query.supportedCommands()` | 低，有改善 | S（Phase E） |
| **model 列表** | 前端硬编码 | `query.supportedModels()` | 低，有改善 | S（Phase E） |
| **MCP 服务** | CLI `--mcp-config` arg | `options.mcpServers` | 低 | S |
| **session 持久化** | CLI 自动写 `~/.claude/*.jsonl` | SDK 默认 `persistSession: true` | 低 | XS |
| **WebSocket broadcast** | 一个 session 多 client 共享 | SDK query 是单消费者，广播需 server 层包装（session pump） | 中 | M（Phase B2） |

**图例**: XS <1天 / S 1-2天 / M 3-5天 / L >1周

---

## 四、风险点

### 风险 1：interrupt 行为不是 drop-in（高风险，codex review 必修#1）

**问题**: `query.interrupt()` 方法存在，但 smoke 观测结果是 `result.subtype = "error_during_execution"` 加上抛出的异常，而非 `interrupted` subtype。

**结论**: interrupt 需要在 server adapter 层显式做异常捕获 + 状态归一化，映射到 `NanocodeAgentEvent: phase='turn_failed'`。当前 nanocode 的 interrupt 路径（清队列 + info event）需要 Phase C 专项对齐。移出 Phase B POC 范围。

### 风险 2：queue/active-guard 是 design，不是 dead code（codex review 必修#3）

**问题**: v1 plan 将 busy/queue 标为"低风险简化可删"。

**结论**: queue 承担三个职责：
- 对用户即时反馈（`session-controller.js:153-162`）
- 将队列中的消息合并成一个 turn（`:285-289`）
- interrupt 后丢弃队列（`:277-284`）

active-guard 承担 session 碰撞检查（`claude-history.js:234-296`）。两者都需要在 SDK 路径下重新设计，不是简单删除。

### 风险 3：/resume 拦截不能在 day-one 删除（codex review 必修#4）

**结论**: SDK 的 `options.resume` 只解决"已知 session_id 的精确 resume"。当前 /resume 还做 recent-session 选择、project 过滤、active-session 跳过。保留到等价实现就绪。

### 风险 4：history 迁移需要适配层（codex review 必修#5）

**B1 smoke 证实**: `getSessionMessages()` 返回 normalized `user/assistant` 消息 + timestamp，与现有 replay-event history 的 block-level dedup 格式**不同**。直接替换会破坏 replay seeds 和 renderer 期待的事件结构。History 迁移独立放 Phase D。

### 风险 5：cross-dir resume 全失败（B1 smoke 实证）

**B1 smoke 证实**: 跨 cwd 的 `resume` SDK 和 CLI 都报 "No conversation found"。Phase B2 必须保留 cwd-aware session 映射，确保 resume 使用正确的 project transcript root。

### 风险 6：thinking 行为漂移（B1 smoke 实证）

**B1 smoke 证实**: SDK thinking prompt 下未输出任何 thinking block（CLI 有），且给出了错误计算答案。两端 claude_code_version 不同（SDK=2.1.165，CLI=2.1.162）。Thinking 相关渲染和语义需要 Phase B2.5 专门验证门禁，不在 B2 承诺范围内。

### 风险 7：SDK credit 计费（Team 订阅，codex review 必修#2）

从 2026-06-15 起，Agent SDK 用量走独立的月度 credit（per-user，non-pooled）。超额后行为取决于 usage credits 是否开启。上线前需确认 seat 层级和超额策略。

### 风险 8：OAuth 仅内部适用（codex review 必修#6）

当前 OAuth 凭证复用适用于本机 nanocode wrapper，不适用于外部分发产品。

---

## 五、Phase 路线图（已按 codex review 重排序）

### Phase B1: smoke + stream parity（已完成）

**状态**: 完成，产物在 `~/codex_work/sdk_b1_smoke/`

**结论**:
- SDK install、OAuth reuse、`query()` async generator、same-cwd resume、tool-use stream parity 已验证
- 两个危险点：cross-dir resume 全失败、thinking 行为漂移
- 可推进 Phase B2

### Phase B2: server-side adapter only（1-2 天）

**目标**: nanocode server 能用 SDK 驱动 claude session（并行于现有 CLI path）

1. 新建 `terminal/claude-sdk-adapter.js`
2. 消费 SDK raw events，forward 到现有 WS renderer contract（统一 envelope 见 UNIFIED_ADAPTER.md）
3. `rate_limit_event` 做 position-independent 处理
4. 保留 cwd-aware session 映射（cross-dir resume 需正确 project root）
5. tool turns 用 `maxTurns > 1`

**不做**: 删 queue/active-guard、删 /resume 拦截、interrupt UI、thinking parity、frontend 改动

**退出条件**: text + tool block 能到前端 block renderer 并正确渲染，result message 到达，无 frontend work

### Phase C: interrupt + queue parity（1-2 天）

**目标**: interrupt 行为和 queue 语义在 SDK 路径下达到 CLI 路径等价

1. server adapter 显式捕获 `query.interrupt()` 的异常，归一化为 `phase='turn_failed'`
2. 重新设计 queue：立即反馈 + 合并 turn + interrupt 清队列
3. 重新设计 active-guard：cwd-aware session 碰撞检查
4. Smoke 验证：`interrupt → queue drained → info event` 路径

### Phase D: history API swap（1-2 天）

**目标**: 用 `listSessions()` / `getSessionMessages()` 替换 `claude-history.js` 的 jsonl parse

- 注意：output shape 不同，需要 adapter 层从 normalized messages 重建 renderer 期待的 block event 结构
- /resume 拦截删除条件：recent-session 选择 parity 就绪后

### Phase E: auth / model / slash cleanup（1-2 天）

1. `auth status` 改用 `query.accountInfo()`
2. `model list` 改用 `query.supportedModels()`
3. `slash commands` 改用 `query.supportedCommands()`
4. permission_mode / model / effort 动态切换

---

## 六、回退策略

- `zhining/nanocode-selfresume-bugs` 保持当前 CLI wrap 架构，继续服役
- POC 在 `zhining/sdk-rewrite` 独立验证，不影响生产
- SDK path 达到 **全 feature parity** 前不删除 CLI wrap 代码
- 如 SDK credit 超额或有重大 breaking change，可随时回退到 CLI wrap

---

## 七、估算

| Phase | 工作量估算 | 说明 |
|---|---|---|
| B1（smoke） | 完成 | 产物在 `~/codex_work/sdk_b1_smoke/` |
| B2（server adapter） | 1-2 天 | server-side only，forward SDK events |
| C（interrupt/queue） | 1-2 天 | redesign，不是 deletion |
| D（history） | 1-2 天 | 需 shape adapter 层 |
| E（auth/model/slash） | 1-2 天 | API cleanup |
| **总计（B2 起）** | **~5-8 天** | 分阶段，每阶段可独立 QA |

预计可删除代码：**~1200-1500 行**（Phase D 完成后，含 claude-history.js、session-controller 的 spawn/dedup/lock 部分）

---

## 八、参考文档

- [Agent SDK Overview](https://code.claude.com/docs/en/agent-sdk/overview)
- [TypeScript SDK Reference](https://code.claude.com/docs/en/agent-sdk/typescript)
- [Authentication](https://code.claude.com/docs/en/authentication)
- [Agent SDK with Subscription Plans](https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan)
- B1 Smoke Report: `~/codex_work/sdk_b1_smoke/REPORT.md`
- Codex Adversarial Review: `~/codex_work/SDK_PLAN_CODEX_REVIEW.md`
- Unified Adapter Design: `research/sdk-migration/UNIFIED_ADAPTER.md`
