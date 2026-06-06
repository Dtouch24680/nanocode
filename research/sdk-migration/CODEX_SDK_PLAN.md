# nanocode → @openai/codex-sdk 迁移方案

> 版本: v2.0 | 日期: 2026-06-06 | 作者: Sonnet 调研 → Codex 对抗审核 → v2 整合
> 变更摘要见同目录 CHANGELOG.md

---

## 一、现状评估

### 当前 codex tab 架构

nanocode codex tab 是**纯 PTY wrap**，完全不同于 claude tab 的 JSON stream。架构图：

```
Browser → WebSocket(/ws/terminal) → Node.js Express Server
                                           ↓
                              sessions.js (PtySession)
                                           ↓
                 node-pty spawn('codex', ['--dangerously-bypass-approvals-and-sandbox'])
                                           ↓
                       raw PTY bytes (ANSI escape + VT100 alt-screen + sync-output)
                                           ↓
                    CodexBlockRenderer (前端 1415 行 ANSI parser)
                    — stripAnsi / VT100Screen / processLine pattern detect
```

**关键产品事实（codex review 必修#6）**：codex tab 的**默认渲染是 raw PTY terminal mode**，不是 block mode（`tab-manager.js:370`，`app.js:348`）。用户当前看到的是带有 TUI spinner/进度/颜色/alt-screen 的真实 PTY 输出。删除 1415 行 ANSI parser + 切换到 SDK JSON events 是**用户可感知的 product change**，不是透明的内部替换。

### 核心代码行数统计

| 文件 | 行数 | 职责 |
|---|---|---|
| `public/js/codex-block-renderer.js` | 1415 | 前端 ANSI parser / VT100Screen / block renderer |
| `terminal/claude-session-controller.js` | 571 | 含 TAB_LAUNCHERS.codex spawn command（第60行） |
| `terminal/sessions.js` | 398 | PtySession / enableCodexAutoSkip (N30 autoskip) |
| **codex 专属胶水合计** | **~300** | TAB_LAUNCHERS.codex + enableCodexAutoSkip + auto-skip 检测（~40行） |

---

## 二、SDK 概览

### Package

```bash
npm install @openai/codex-sdk@0.137.0
```

- **npm package**: `@openai/codex-sdk`
- **当前最新稳定**: 0.137.0（2026-06-04 发布）
- **release cadence**: 2.6 个版本/天（247 天内 635 个版本）

### Binary Resolution（codex review 必修#1，v1 描述错误）

**默认行为（bundled-first，不是 PATH-first）**：

SDK 内部 `CodexExec.findCodexPath()` 优先解析 `@openai/codex-linux-x64/.../vendor/.../bin/codex`（捆绑 binary），**不读系统 PATH**（`dist/index.js:159-166,380-449`）。

- Smoke 验证：bundled binary 版本 = 0.137.0（`codex_sdk_smoke/node_modules/@openai/codex-linux-x64/...`）
- 系统 codex 路径 = `/storage/home/zhiningjiao/code/.local/bin/codex`（实际路径，**不是** `~/.local/bin/codex`）
- 系统 codex 版本 = **0.125.0**（实际版本，v1 误写为 0.134.0）

`codexPathOverride` 可强制指向系统 binary（0.125.0），smoke 验证与 SDK 0.137.0 不存在立即的硬失败，但 protocol 漂移风险仍存在。

**结论**：迁移默认走 bundled binary（0.137.0），`codexPathOverride` 是显式兼容模式，不是默认。

### 认证方式

主人当前 codex 认证为 `auth_mode: chatgpt`（ChatGPT OAuth token，存 `~/.codex/auth.json`），不是 OpenAI API key。

SDK 调用 bundled codex binary，binary 读 `~/.codex/auth.json`，SDK 的 `apiKey` 参数走 `CODEX_API_KEY` env（API key 路径，不同于 ChatGPT OAuth）。

**Smoke 验证**：不设 `OPENAI_API_KEY` / `CODEX_API_KEY`，bundled binary 成功用 `~/.codex/auth.json` 的 ChatGPT token 认证（`simple_bundled` / `rich_schema` smoke 均成功）。

**与 claude SDK 的对比**：claude SDK 用 Claude Team 订阅（Anthropic）；codex SDK 用 ChatGPT 订阅（OpenAI）。两套账号体系完全独立，双 SDK 并用不互相影响配额。

### 核心 API

```typescript
import { Codex, Thread } from '@openai/codex-sdk';

const codex = new Codex({ codexPathOverride?: string });

// 新对话
const thread: Thread = codex.startThread({
  model?: string,
  sandboxMode?: SandboxMode,
  workingDirectory?: string,
  modelReasoningEffort?: ModelReasoningEffort,
  approvalPolicy?: ApprovalMode,
  additionalDirectories?: string[],
});

// 恢复历史对话
const thread = codex.resumeThread(threadId, options?);

// 流式执行
const { events } = await thread.runStreamed('input text', { signal?: AbortSignal });
for await (const event of events) { /* ThreadEvent */ }
```

### Event Stream（smoke 验证的真实 shape）

| Event 类型 | 含义 |
|---|---|
| `thread.started` | 含 `thread_id`（用于 resume）|
| `turn.started` | 开始处理 |
| `item.started` | item 开始（in_progress），含 `item.id` |
| `item.updated` | item 更新（命令执行中） |
| `item.completed` | item 完成，含最终 `aggregated_output` / `exit_code` |
| `turn.completed` | 含 `usage`（input/output/reasoning tokens） |
| `turn.failed` | 含 `error.message` |

**Thread item 类型（smoke 实证）**：

| item.type | Smoke 状态 | 含义 |
|---|---|---|
| `agent_message` | 已验证（rich_schema）| 模型文字回复 |
| `command_execution` | 已验证（rich_schema）| shell 命令 + output |
| `file_change` | 已验证（rich_schema）| 文件变更 |
| `reasoning` | **未观测到**（codex review 必修#4）| 推理内容，`show_raw_agent_reasoning=true` 也未触发 |
| `mcp_tool_call` | 未测试 | MCP 工具调用 |

---

## 三、现有 Feature 迁移对照表

| Feature | 当前实现 | SDK 等价 | 迁移风险 | 工作量 |
|---|---|---|---|---|
| **PTY spawn codex** | `pty.spawn('codex', ['--dangerously-bypass-approvals-and-sandbox'])` | `codex.startThread({ approvalPolicy: 'never', sandboxMode: 'danger-full-access' })` | 中：不再是 PTY，输入输出模型完全不同 | S |
| **ANSI/VT100 raw stream** | node-pty → WS raw bytes | SDK async generator emit ThreadEvent（JSON） | 低：可删 1415 行，但这是**产品可感知变化** | Phase D（不能提前） |
| **VT100Screen alt-screen** | 自写 VT100Screen（200+ 行）| SDK 已解析 | 低，可删，但 **PTY fallback 保留到 B2/C**（codex review 必修#6）| Phase D |
| **pattern detection** | regex-based 正则 | SDK 原生结构化 item | 低，可删 | Phase D |
| **block renderer** | CodexBlockRenderer | 新 block renderer 消费 lifecycle envelope | 低，需新写 ~200-300 行，**不能提前删 1415 行旧版** | Phase D |
| **interrupt（Ctrl-C）** | `sendRaw('\x03')` → PTY SIGINT | `AbortSignal`（`TurnOptions.signal`） | **高（codex review 必修#3）**：smoke 证实 AbortSignal 抛 `AbortError`，无结构化 interrupt event，独立 Phase C 研究 | Phase C |
| **session resume** | PTY 内 codex 自己管 | `codex.resumeThread(thread_id)` — smoke 已验证 | 中：需持久化 thread_id 到 tab state | M |
| **session history** | PTY scrollback | `resumeThread` 解决，不需要 replay bytes | 低 | S |
| **model 切换** | codex 内 `/model` 命令 | `startThread({ model: 'gpt-5.5' })` | 低 | XS |
| **effort 切换** | config.toml | `startThread({ modelReasoningEffort: 'xhigh' })` | 低 | XS |
| **approval 模式（bypass）** | CLI arg `--dangerously-bypass-approvals-and-sandbox` | `startThread({ approvalPolicy: 'never', sandboxMode: 'danger-full-access' })` | 低，直接映射 | XS |
| **approval modal（on-request）** | 无（当前直接 bypass）| 无（codex review 必修#7）：SDK event union 没有 approval-request event，**迁移目标仅 `approvalPolicy: 'never'`** | **高：approval UX 是独立研究课题** | 不在当前路线图 |
| **reasoning 渲染** | 无（PTY 混在文字里）| `reasoning` ThreadItem | **中（codex review 必修#4）**：smoke 未能观测到 reasoning item，即使有 `reasoning_output_tokens`，承诺 UI parity 尚无依据 | 不在 B2 承诺范围 |
| **enableCodexAutoSkip（N30）** | 检测 update TUI box-drawing，发 "2\n" | SDK 路径没有 update prompt | 低，可删（SDK 路径稳定后） | XS |
| **codexRenderMode 设置** | terminal / block 两种模式 | SDK 只有 block 模式，terminal mode 需保留到 B2/C | **保留 PTY fallback**（codex review 必修#6） | Phase D |
| **MCP 工具调用渲染** | 无（PTY 不能结构化解析）| `mcp_tool_call` ThreadItem | 低，有改善 | S（Phase D 后） |
| **file_change 渲染** | 无（PTY 只有文字）| `file_change` ThreadItem（已 smoke 验证）| 低，有改善 | S（Phase D） |

**图例**: XS <1天 / S 1-2天 / M 3-5天 / L >1周

---

## 四、风险点

### 风险 1：Binary resolution 默认是 bundled，不是系统 PATH（codex review 必修#1）

SDK 默认用 bundled binary（0.137.0），不读系统 PATH。系统实际 codex = 0.125.0（不是 v1 写的 0.134.0，路径也不同）。`codexPathOverride` 可强制用系统版本，但这是兼容 mode，不是默认。

### 风险 2：AbortSignal 不是干净的中断协议（codex review 必修#3）

**Smoke 证实**：3 组 abort 测试（`abort_sleep` / `abort_sleep_late` / `abort_sleep_5s`）全部抛出 `AbortError: The operation was aborted`，只有 `thread.started` + `turn.started` 两个事件，没有 `turn.failed` / `error` / 任何结构化中断事件。

`AbortSignal` 中断必须作为**独立 Phase C 研究**，不能在 B2 里承诺 interrupt UI parity。

### 风险 3：reasoning 可见性未证实（codex review 必修#4）

`raw_reasoning` smoke（`config.show_raw_agent_reasoning=true`）：stream 中有 `reasoning_output_tokens: 41`，但**没有 `reasoning` item 被 emit**。不要承诺 codex reasoning block UI，直到有实际 smoke 证实 `item.type === 'reasoning'` 出现。

### 风险 4：approval flow 未解决（codex review 必修#7）

SDK event union 中没有 approval-request event。当前 nanocode 用 `--dangerously-bypass-approvals-and-sandbox`。迁移目标仅 `approvalPolicy: 'never'`，on-request 模式是独立研究课题，不在本路线图。

### 风险 5：PTY terminal mode 删除是产品变化（codex review 必修#6）

当前 codex tab 默认是 raw PTY terminal（不是 block mode）。删除 1415 行 ANSI parser 会移除 TUI spinner / 颜色 / alt-screen 体验，是用户可感知的变化。PTY fallback 保留到 Phase D 且 SDK block mode 被主人确认优于 PTY 为止。

### 风险 6：thread_id 持久化新增复杂度

SDK 模式需要 nanocode 持久化 `thread_id` 到 tab metadata；resume 时正确传入 cwd 和 thread_id。当前 PTY 模式不需要 nanocode 侧持久化。

### 风险 7：SDK 版本超快

635 个版本 / 247 天（2.6 版/天）。建议 pin SDK 版本，每次升级先跑 smoke。

---

## 五、Phase 路线图（按 codex review 重排序）

### Phase B1'（smoke + stream parity）— 已完成

**状态**: 完成，产物在 `~/codex_work/codex_sdk_smoke/output/`

**验证结论**:
- bundled binary 默认路径工作（ChatGPT OAuth）
- `startThread / runStreamed` 正常
- `resumeThread(thread_id)` 正常
- `agent_message` / `command_execution` / `file_change` 三类 item 已验证
- `reasoning` item 未出现（`raw_reasoning` smoke）
- AbortSignal 全部抛 AbortError，无结构化中断事件

### Phase B2'（server-side codex SDK driver）— 1-2 天

**目标**: nanocode server 能用 SDK 驱动 codex tab（feature flag，并行于 PTY 路径）

1. 新建 `terminal/codex-sdk-driver.js`
2. 实现 `createCodexSdkDriver({ store, home })`
3. 适配 `thread.started` → 持久化 `codex_thread_id` 到 tab store
4. 将 ThreadEvents 经 lifecycle-preserving envelope 转发到 WS client（见 UNIFIED_ADAPTER.md）
5. **保留 PTY codex 路径**，feature flag `codexSdkMode` 切换

**不做**: 新 block renderer、删 CodexBlockRenderer、interrupt UI、reasoning 渲染

**退出条件**: `agent_message` 和 `command_execution` 事件能到前端并显示

### Phase C'（interrupt 专项研究）— 1-2 天

**目标**: 明确 AbortSignal 中断的 server-side 处理策略

1. 研究 abort 后子进程状态（是否需要 kill + cleanup）
2. 建立 exception-to-event 映射策略
3. 归一化到 `phase='turn_failed'` envelope
4. 不承诺 UI parity 直到 server-side mapping 稳定

### Phase D'（block renderer 重构）— 2-3 天

**目标**: 删除 1415 行 ANSI parser，**在主人确认 SDK block mode 体验优于 PTY 后执行**

1. 新写 `codex-sdk-block-renderer.js`（消费 lifecycle envelope）
2. 渲染 `agent_message` / `command_execution` / `file_change` blocks
3. 与 claude tab block renderer 外观一致（共用 CSS）
4. 删除 `codex-block-renderer.js` 及 VT100Screen / ANSI regex
5. 保留 `codexRenderMode=terminal` xterm raw fallback（可选关闭）

### Phase E'（model / effort / session picker）— 1-2 天

1. 前端 model 下拉（硬编码，SDK 无 `supportedModels()`）
2. effort 下拉（minimal / low / medium / high / xhigh）
3. tab header 显示 thread_id（可复制用于 resume）

---

## 六、回退策略

- 当前 PTY codex tab 保持不变，SDK path 在 feature flag 下开发
- SDK path 达到 feature parity 前不删除 PTY path
- `codexRenderMode=terminal` 保留作为 fallback

---

## 七、估算

| Phase | 工作量 | 说明 |
|---|---|---|
| B1'（smoke）| 完成 | 产物在 `~/codex_work/codex_sdk_smoke/output/` |
| B2'（server driver）| 1-2 天 | feature flag，不删 PTY |
| C'（interrupt 研究）| 1-2 天 | 独立研究，不承诺 parity |
| D'（block renderer）| 2-3 天 | 主人确认后执行 |
| E'（model/effort/session）| 1-2 天 | UI 控件 |
| **总计（B2' 起）** | **~5-9 天** | 分阶段，每阶段可独立 QA |

**可删除代码（Phase D' 后）**：`codex-block-renderer.js` 1415 行 + `TAB_LAUNCHERS.codex` 1 行 + `enableCodexAutoSkip` 40 行 = ~1460 行
**新增代码**：`codex-sdk-driver.js` ~200 行 + `codex-sdk-block-renderer.js` ~300 行 = ~500 行
**净减少**：~960 行

---

## 八、关键验证点（B1' 实证结论）

| 验证项 | 结论 | 产物 |
|---|---|---|
| bundled binary 默认路径 + ChatGPT OAuth | 成功 | `simple_bundled.jsonl` |
| system codex override（0.125.0）| 成功（无立即协议失败）| `simple_system_override.jsonl` |
| resumeThread | 成功 | `resume_bundled.jsonl` |
| command_execution + file_change | 成功 | `rich_schema.jsonl` |
| reasoning item 可见性 | **失败：未 emit**，`reasoning_output_tokens: 41` 存在 | `raw_reasoning.jsonl` |
| AbortSignal 中断 | **失败：全部 AbortError**，无结构化事件 | `abort_sleep*.meta.json` |

---

## 九、参考文档

- [npm: @openai/codex-sdk](https://www.npmjs.com/package/@openai/codex-sdk)
- [GitHub: openai/codex](https://github.com/openai/codex)
- Codex SDK Adversarial Review: `~/codex_work/CODEX_SDK_PLAN_CODEX_REVIEW.md`
- Unified Adapter Design: `research/sdk-migration/UNIFIED_ADAPTER.md`
- Smoke outputs: `~/codex_work/codex_sdk_smoke/output/`
