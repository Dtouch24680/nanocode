# nanocode → Claude Agent SDK 迁移方案

> 版本: v1.0 | 日期: 2026-06-06 | 作者: Sonnet 调研

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

另外 `server/index.js`（481行）和 `server/router-mode.js`（261行）有少量 auth 状态检查也依赖 CLI。

### 已知架构债

1. **`/resume` 拦截**：CLI 非交互模式不支持 /resume，要在 session-controller 里拦截并重写成 `--resume` 参数
2. **stream-json dedup**：CLI 在 reconnect/replay 时会重放历史 event，自己维护 `replay_id` Map 去重
3. **session lock/queue**：CLI spawn 是串行的，自己写 `busy` / `queue` / GC stale lock 逻辑
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
- **当前版本**: 0.3.x（2026-06）
- **Node.js 要求**: 18+
- SDK **自带捆绑的 claude 二进制**，不需要单独装 Claude Code CLI

### 认证方式

SDK 继承 Claude Code CLI 的认证栈，优先级从高到低：

| 优先级 | 方法 | 适用场景 |
|---|---|---|
| 1 | `ANTHROPIC_API_KEY` env | API key 计费（Console 账号） |
| 2 | `CLAUDE_CODE_OAUTH_TOKEN` env | CI/脚本，`claude setup-token` 生成一年有效 OAuth token |
| 3 | OAuth `/login` 会话凭证 | 交互登录（Pro/Max/Team/Enterprise 订阅） |
| 4 | Cloud provider（Bedrock/Vertex/Azure） | 企业部署 |

**关键结论**：SDK **支持 OAuth 订阅凭证**（Pro/Max/Team/Enterprise）。主人的账号用 OAuth 登录 Claude Code，SDK 会复用 `~/.claude/.credentials.json`，无需单独 API key。

**June 15, 2026 新计费**：Agent SDK 用量从订阅的互动额度里独立出来，Pro=$20/月信用额，Max 5x=$100/月，Max 20x=$200/月。

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

**关键 Options**：
- `resume: sessionId` — 恢复历史 session（原生支持，SDK 自己读 jsonl）
- `continue: true` — 继续最近一次会话
- `interrupt()` — Query 对象方法，原生 interrupt
- `permissionMode` — `default` / `acceptEdits` / `plan` / `bypassPermissions`（三态或更多）
- `model` / `effort` — 原生参数
- `thinking` — ThinkingConfig，原生支持 thinking blocks
- `mcpServers` — MCP 配置，原生支持
- `canUseTool` — 自定义权限回调

---

## 三、现有 Feature 迁移对照表

| Feature | 当前实现 | SDK 等价 | 迁移风险 | 工作量 |
|---|---|---|---|---|
| **spawn Claude 进程** | `spawn('claude', ['--print', '--output-format=stream-json'])` | `query({prompt, options})` | 低 | XS |
| **stream-json 接收** | 手工 readline + JSON.parse | async generator（原生） | 低 | XS |
| **stream dedup** | 自维护 `replay_id` Map | SDK 内置，无需 dedup | 低，可删 317 行 | XS（删代码） |
| **session 历史加载** | 手工 parse `~/.claude/*.jsonl` | `listSessions()` / `getSessionMessages()` / `resume: sessionId` | 低，现有 jsonl 格式兼容 | S |
| **session resume** | `--resume=<id>` CLI arg | `options.resume = sessionId` | 低 | XS |
| **/resume 拦截** | 检测用户输入 `/resume` 并重写 | 原生支持，可删拦截逻辑 | 低，可删 | S（删代码） |
| **/continue 拦截** | 类似 /resume | `options.continue = true` | 低 | XS |
| **busy/queue** | 自维护 `busy` flag + `queue` 数组 | SDK turn 管理（一次 query 一个 turn） | 中，需要重设计并发模型 | M |
| **interrupt** | SIGINT 到子进程 | `query.interrupt()` 原生方法 | 低 | S |
| **session lock GC** | 轮询 PID 是否存活 | SDK 无需此机制 | 低，可删 | XS（删代码） |
| **permission_mode 三态** | 前端下拉 → CLI arg | `options.permissionMode` / `query.setPermissionMode()` | 低 | S |
| **model 下拉** | CLI arg `--model` | `options.model` / `query.setModel()` | 低 | XS |
| **effort 下拉** | CLI arg `--effort` | `options.effort` | 低 | XS |
| **thinking blocks** | event schema `thinking` type 渲染 | SDK emit 同样 event，schema 不变 | 低 | XS |
| **tool_use 渲染（Edit/Write/Read）** | 解析 `tool_use` event 的 input | SDK emit 相同 `SDKAssistantMessage.message.content[]` | 低，event schema 兼容 | S（验证 schema） |
| **auth status 检查** | `execFile('claude', ['auth', 'status'])` | `query.accountInfo()` | 低 | XS |
| **slash commands 列表** | 目前硬编码或 CLI 无法查询 | `query.supportedCommands()` | 低，有改善 | S |
| **model 列表** | 前端硬编码 | `query.supportedModels()` | 低，有改善 | S |
| **MCP 服务** | CLI `--mcp-config` arg | `options.mcpServers` 原生配置 | 低 | S |
| **session 持久化** | 依赖 CLI 自动写 `~/.claude/*.jsonl` | SDK 默认 `persistSession: true`，自动写 | 低，行为一致 | XS |
| **custom session store** | 不支持 | `options.sessionStore` | 低，可选扩展 | M（可选） |
| **active-session-guard** | 服务器端 busy flag | SDK 每次 query 自己管，不需要跨连接锁 | 中，需重新思考多客户端连接共享 session 的语义 | M |
| **WebSocket broadcast** | 一个 session 多 client 共享 | SDK query 是单消费者，广播需要 server 层包装 | 中 | M |
| **agent 命名（nanocode）** | 从 jsonl 提取 session_id | SDK `listSessions()` 返回 `SDKSessionInfo[]` 含 title/tag | 低 | S |
| **fast mode** | 目前没有直接对应 | SDK `effort: 'low'` | 低 | XS |
| **skill 支持** | CLAUDE.md + `.claude/skills/` | SDK 读 `settingSources` 默认加载 `.claude/` | 低，行为不变 | XS |

**图例**: XS <1天 / S 1-2天 / M 3-5天 / L >1周

---

## 四、风险点

### 风险 1：OAuth 凭证（中风险，已确认可解决）

**问题**: SDK 文档提到默认 step 2 是 `ANTHROPIC_API_KEY`。

**结论**: SDK **支持 OAuth 订阅凭证**。主人已通过 `claude login` 登录，凭证在 `~/.claude/.credentials.json`，SDK 会复用（优先级 6）。如果环境里没有 `ANTHROPIC_API_KEY`，SDK 自动用 OAuth。可用 `claude setup-token` 生成 `CLAUDE_CODE_OAUTH_TOKEN` 做 CI 固化。

### 风险 2：1M context（低风险）

SDK `model` 参数支持完整 model ID，包括 `claude-opus-4-7`（如需 1M context 版本则用对应 ID）。SDK 不限制模型选择。

### 风险 3：多客户端共享 session（中风险）

当前架构：一个 sessionKey 对应一个 spawn 进程，多个 WebSocket 客户端可以 attach 到同一 session 实时看到 broadcast。

SDK 的 `query()` 是单消费者 async generator。多客户端共享需要在 Server 层做一个 "session pump"：消费 SDK generator，广播到所有订阅的 WS 客户端。这不是无法解决的，但需要重新设计 WS 层。

### 风险 4：busy/queue 语义（低风险，架构简化）

当前 busy/queue 是为了让 CLI 同一 session 串行执行。SDK 的 `query()` 每次调用是一个 turn，天然串行（上一个 query 完成才发下一条）。queue 逻辑可以用 Promise chain 实现，比现在更简洁。

### 风险 5：SDK credit 计费（2026-06-15 起）

从 2026-06-15 起，Agent SDK 用量走独立的月度 credit（Pro $20/月）。主人需要确认 nanocode 迁 SDK 后是否在 credit 范围内。超额后行为待确认（是限速还是 fallback 到 API key 计费）。

### 风险 6：SDK 版本稳定性

SDK 处于快速迭代期（当前 0.3.x），v0.1.0 有过一次 breaking change（ClaudeCodeOptions rename）。建议锁定版本（`@anthropic-ai/claude-agent-sdk@0.3.165`）。

---

## 五、Phase B POC 范围（建议）

最小化跑通，**不做 full feature**：

1. 安装 SDK：`npm install @anthropic-ai/claude-agent-sdk`
2. 新建 `terminal/claude-sdk-driver.js`，替换 `claude-session-controller.js` 中的 spawn 部分
3. 用 SDK `query()` 发一条消息，stream events 直接 forward 到现有 WS broadcast
4. 验证以下 message types 能走到前端 block renderer 并正确渲染：
   - `assistant` message（含 text / tool_use / thinking content blocks）
   - `result` message（`SDKResultMessage.subtype: 'success'`）
   - `status` message（tool_use_started / tool_use_finished）
5. 验证 `resume: sessionId` 能恢复历史会话
6. 验证 `query.interrupt()` 能中断当前 turn

**不做**（后续 phase）：
- 多客户端 broadcast pump
- queue/busy 重构
- auth status 迁移
- slash commands / model 列表 API

---

## 六、Phase C+ 路线图（建议）

按依赖顺序：

| Phase | 内容 | 依赖 |
|---|---|---|
| B | POC：spawn→stream→render 最小跑通 | A（本 commit） |
| C | session pump：单 generator → WS broadcast | B |
| D | interrupt / queue 重构（SDK 原生） | C |
| E | history 迁移：删除 claude-history.js 的 jsonl parse，改用 `listSessions()` | C |
| F | auth status / model list / commands API | E |
| G | permission_mode / model / effort 动态切换（`query.setModel()` 等） | F |
| H | /resume + /continue 拦截删除（SDK 原生支持） | G |
| I | MCP 配置迁移 | H |
| J | 清理旧 CLI wrap 代码，feature parity 验证 | I |
| K | 切 `main` 分支上线 | J |

---

## 七、回退策略

- `zhining/nanocode-selfresume-bugs` 保持当前 CLI wrap 架构，继续服役
- POC 在 `zhining/sdk-rewrite` 独立验证，不影响生产
- SDK path 达到 **全 feature parity** 前不删除 CLI wrap 代码
- 如 SDK credit 超额或有重大 breaking change，可随时回退到 `zhining/nanocode-selfresume-bugs`

---

## 八、估算

| Phase | 工作量估算 | 说明 |
|---|---|---|
| B（POC） | 3-5 天 | spawn→stream→render 最小 POC |
| C（session pump） | 3-5 天 | 多客户端 WS 广播重构 |
| D（interrupt/queue） | 2-3 天 | 简化，代码量减少 |
| E（history） | 2-3 天 | 删 317 行 jsonl parse |
| F-H（API/slash/resume） | 3-5 天 | |
| I-J（MCP/清理/验证） | 5-7 天 | |
| **总计** | **~18-28 天（半天工作量）** | 分阶段，每阶段可独立 QA |

预计可删除代码：**~1200-1500 行**（主要在 claude-history.js、claude-session-controller.js 的 spawn/dedup/queue/lock/resume 拦截部分）

---

## 九、参考文档

- [Agent SDK Overview](https://code.claude.com/docs/en/agent-sdk/overview)
- [TypeScript SDK Reference](https://code.claude.com/docs/en/agent-sdk/typescript)
- [Migration Guide (from claude-code SDK)](https://code.claude.com/docs/en/agent-sdk/migration-guide)
- [Authentication](https://code.claude.com/docs/en/authentication)
- [Agent SDK with Subscription Plans](https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan)
- [npm: @anthropic-ai/claude-agent-sdk](https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk)
