# Unified Adapter Design — 双 SDK 统一 Lifecycle Envelope

> 版本: v1.0 | 日期: 2026-06-06
> 来源: Codex 对抗审核 (`CODEX_SDK_PLAN_CODEX_REVIEW.md`) 的必修建议 #5

---

## 设计目标

在 server 层为 claude SDK 和 codex SDK 的两套原生 event stream 建立**统一的 transport envelope**，供前端 block renderer 消费。

**核心原则（来自 codex review）**：
- 只归一化 session / turn / item **生命周期**，不预先压平 provider-native payload
- 保留 item lifecycle：`started / updated / completed`
- 保留 stable `item_id`（用于 running state UI）
- 保留 provider-native `payload`，让 frontend renderer 决定如何折叠
- 不假设两个 provider 的 schema 已经相同

---

## Envelope Schema

```typescript
/**
 * 统一 lifecycle envelope，server → WS client
 * provider: 'claude' | 'codex'
 */
type NanocodeAgentEvent =
  | {
      provider: 'claude' | 'codex';
      phase: 'session_started';
      session_id: string;
    }
  | {
      provider: 'claude' | 'codex';
      phase: 'turn_started';
      session_id: string;
    }
  | {
      provider: 'claude' | 'codex';
      phase: 'item';
      lifecycle: 'started' | 'updated' | 'completed';
      session_id: string;
      item_id: string;
      item_kind: 'text' | 'reasoning' | 'command' | 'file_change' | 'tool_call' | 'todo' | 'error';
      payload: unknown;   // provider-native 原始字段，不提前折叠
    }
  | {
      provider: 'claude' | 'codex';
      phase: 'turn_completed';
      session_id: string;
      usage?: unknown;
    }
  | {
      provider: 'claude' | 'codex';
      phase: 'turn_failed';
      session_id: string;
      error: unknown;
    }
  | {
      provider: 'claude' | 'codex';
      phase: 'stream_error';
      session_id?: string;
      error: unknown;
    };
```

---

## Claude SDK → Envelope 映射

| Claude SDK Event | Envelope phase | item_kind | 说明 |
|---|---|---|---|
| `system:init` | — | — | 不 forward（内部） |
| `assistant` message with `text` content | `item` lifecycle=`completed` | `text` | payload = `{ text }` |
| `assistant` message with `thinking` content | `item` lifecycle=`completed` | `reasoning` | payload = `{ text: thinking.thinking }` |
| `assistant` message with `tool_use` content | `item` lifecycle=`started`→`completed` | `tool_call` | payload = `{ name, input, result? }` |
| `user` message with `tool_result` | 附加到对应 item lifecycle | `tool_call` | 追加 result 到 payload |
| `result:success` | `turn_completed` | — | usage 附加 |
| `result:error_during_execution` | `turn_failed` | — | interrupt 归一化到此（`query.interrupt()` smoke 实证结论） |
| `result:error_max_turns` | `turn_failed` | — | |
| `system:status` (session_id 初始化) | `session_started` | — | session_id 从 init event 提取 |

**注意（B1 smoke 结论）**：
- `rate_limit_event` 是 position-independent，不触发 envelope 事件
- `system:thinking_tokens` 只在 CLI 路径出现，SDK 路径需额外验证后才能信任
- cross-dir resume 失败时会映射到 `turn_failed`

---

## Codex SDK → Envelope 映射

| Codex SDK Event | Envelope phase | item_kind | 说明 |
|---|---|---|---|
| `thread.started` | `session_started` | — | session_id = `thread_id` |
| `turn.started` | `turn_started` | — | |
| `item.started(agent_message)` | `item` lifecycle=`started` | `text` | payload = `{ text: '' }` |
| `item.completed(agent_message)` | `item` lifecycle=`completed` | `text` | payload = `{ text }` |
| `item.started(command_execution)` | `item` lifecycle=`started` | `command` | payload = `{ command, status: 'in_progress' }` |
| `item.updated(command_execution)` | `item` lifecycle=`updated` | `command` | payload = `{ command, aggregated_output, status }` |
| `item.completed(command_execution)` | `item` lifecycle=`completed` | `command` | payload = `{ command, aggregated_output, exit_code, status }` |
| `item.completed(file_change)` | `item` lifecycle=`completed` | `file_change` | payload = `{ changes[], status }` |
| `item.completed(reasoning)` | `item` lifecycle=`completed` | `reasoning` | payload = `{ text }` **（目前 smoke 未观测到，标注为 unproven）** |
| `turn.completed` | `turn_completed` | — | usage 附加 |
| `turn.failed` | `turn_failed` | — | error 附加 |
| AbortError（thrown）| `turn_failed` | — | exception 捕获归一化 |

---

## Adapter 层位置

```
claude SDK query generator     codex SDK runStreamed generator
           ↓                              ↓
  claude-sdk-adapter.js         codex-sdk-driver.js
           ↓                              ↓
     NanocodeAgentEvent (lifecycle envelope JSON)
                    ↓
            WS broadcast → 前端 block renderer
```

两个 adapter 文件独立实现，输出统一格式。前端消费单一 event shape，不需要关心 provider。

---

## 前端 Block Renderer 消费指引

1. `session_started` → 更新 session_id / thread_id 到 tab state
2. `turn_started` → UI 进入 "thinking..." 状态
3. `item(lifecycle=started)` → 创建新 block（由 `item_id` 标识），`command` kind 显示 "running..." 状态
4. `item(lifecycle=updated)` → 更新已有 block（匹配 `item_id`），追加 partial output
5. `item(lifecycle=completed)` → 标记 block 完成，显示最终内容
6. `turn_completed` → 关闭 thinking 状态，显示 usage
7. `turn_failed` → 显示错误状态（含 interrupt 归一化后的"中断"信息）
8. `stream_error` → fatal 错误，session 进入 error 状态

---

## 未解决事项（不在本 envelope 决定范围）

- `reasoning` item 可见性（codex SDK smoke 未观测到）：保留 `item_kind = 'reasoning'`，但不承诺 codex 侧会 emit
- interrupt 的 server-side cleanup（Phase C 研究）：归一化到 `turn_failed` 之前需要确认子进程状态
- approval flow（codex SDK 无 approval-request event）：不在当前 envelope 中建模

---

## 参考

- Codex adversarial review 必修#5: `~/codex_work/CODEX_SDK_PLAN_CODEX_REVIEW.md:257-279`
- Codex smoke simple_bundled: `~/codex_work/codex_sdk_smoke/output/simple_bundled.jsonl`
- Codex smoke rich_schema: `~/codex_work/codex_sdk_smoke/output/rich_schema.jsonl`
- Claude B1 smoke tool parity: `~/codex_work/sdk_b1_smoke/output/sdk_tool.jsonl`
