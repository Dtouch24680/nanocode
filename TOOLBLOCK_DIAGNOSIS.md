# Tool Block 渲染诊断报告

诊断时间：2026-06-03
诊断范围：`public/js/claude-block-renderer.js` + `terminal/routes.js`
nanocode 状态：运行中（http://127.0.0.1:3001 → 200）

---

## 一、官方标准格式摘要

### Streaming 事件序列（官方）

Claude API 以 Server-Sent Events (SSE) 的形式流式发送内容，关键事件序列：

```
content_block_start   → {"type":"content_block_start","index":N,"content_block":{"type":"tool_use","id":"toolu_xxx","name":"...", "input":{}}}
content_block_delta   → {"type":"content_block_delta","index":N,"delta":{"type":"input_json_delta","partial_json":"{\"key\":"}}
content_block_stop    → {"type":"content_block_stop","index":N}
```

### tool_use block 结构（官方）

```json
{
  "type": "tool_use",
  "id": "toolu_abc123",
  "name": "get_weather",
  "input": { "location": "Paris" }
}
```

- `id`：全局唯一，用于将 tool_use 与后续 tool_result 配对
- `input`：streaming 时通过 `input_json_delta` 的 `partial_json` 分片到达；`content_block_stop` 时才完整

### tool_result block 结构（官方）

tool_result 出现在紧跟在 tool_use 之后的 **user** turn 里：

```json
{
  "role": "user",
  "content": [
    {
      "type": "tool_result",
      "tool_use_id": "toolu_abc123",      ← 必须与 tool_use.id 对应
      "content": "72°F and sunny",         ← string 或 array
      "is_error": false                    ← 可选，工具出错时为 true
    }
  ]
}
```

- `content` 可以是 `string` 或 `[{type:"text",text:"..."}, ...]` 数组（也可含 image 类型）
- `tool_use_id` 是唯一配对依据；没有配对 id 就无法关联到哪个 tool_use

---

## 二、逐条排查结果

### 排查点 1：tool_use 和 tool_result 是否被渲染成互不关联的孤立块

**结论：确认是症状之一。**

代码路径：
- tool_use 由 `_renderToolUsePart(part)` 渲染（第 604–691 行），产生 `.cbr-block-tool` 块
- tool_result 由 `_renderToolResultPart(part)` 渲染（第 693–712 行），产生 `.cbr-block-tool-result` 块

**关键问题**：`_renderToolResultPart` 完全没有使用 `part.tool_use_id` 字段（第 693 行开始的代码里从未读取 `part.tool_use_id`）。渲染时没有任何配对逻辑——tool_result 被作为独立的孤儿块插入到 DOM 的末尾，与 tool_use 块之间没有视觉或 DOM 关联。

官方语义要求：tool_result 应该是 tool_use 的"返回值"，两者本应关联展示；当前实现把它们渲染为完全分离的两个 article 元素，用户看不出对应关系。

---

### 排查点 2：streaming 分片（input_json_delta）处理

**结论：不适用于当前架构，但存在潜在问题。**

nanocode 的 claude 集成不是直接对接 Claude API 的 SSE stream；它是通过 `claude --output-format=stream-json --include-partial-messages` 命令行工具来桥接的（`terminal/routes.js` 第 484–487 行）。

Claude CLI 的 `stream-json` 格式输出的是**已经聚合好的事件**，不是原始 SSE 的 `content_block_delta`。具体来说：

- **`partial_message` 事件**（routes.js 第 524 行 `claudeBroadcast`）：包含当前部分 assistant message，`msg.content` 数组里的 `tool_use` block 的 `input` 字段可能是部分构建的不完整 JSON 对象
- 渲染器的 `_handlePartialMessage`（第 505–536 行）：仅当 `parts.length === 1 && parts[0].type === 'text'` 时才做 live update，其他情况（含 tool_use）全部跳过，等待最终 `assistant` 事件

**潜在 bug**：当 `partial_message` 里有 tool_use 时，`_handlePartialMessage` 会静默跳过（第 535 行注释也承认了），这在最终 `assistant` 事件到来前不会显示任何工具调用进度。这不是崩溃，但导致工具块只在响应完成后才出现，缺少流式进度感。

`_renderToolUsePart` 第 639–647 行：`JSON.stringify(part.input, null, 2)` 是在输入已经是完整对象时调用的（因为 partial 被跳过了），所以不会有 JSON.stringify 空白或报错问题。

---

### 排查点 3：tool_result content 是数组但元素不是 text 时被吞掉

**结论：确认 bug，症状之一。**

`_renderToolResultPart`（第 700–703 行）：

```javascript
} else if (Array.isArray(content)) {
  text = content.filter((c) => c.type === 'text').map((c) => c.text).join('\n')
}
if (!text.trim()) return   // ← 直接 return，整块消失
```

**问题**：
1. 当 `content` 是数组且所有元素的 `type` 都不是 `'text'`（例如 `type: 'image'`，或者 content 是空数组 `[]`），`text` 为空字符串，`if (!text.trim()) return` 会直接返回——这个 tool_result 块从界面上消失，用户完全看不到
2. 当 `content` 是包含单个 `{type:"text", text:""}` 的数组（空文本），同样被吞掉

**实际影响**：某些工具（如截图工具返回 image、文件读取工具返回空内容）的结果会在界面上完全消失。

---

### 排查点 4：is_error 字段有无视觉区分

**结论：没有任何视觉区分。**

`_renderToolResultPart`（第 693–712 行）：完全没有读取 `part.is_error` 字段，所有 tool_result 使用完全相同的 CSS 类 `cbr-block-tool-result`。

成功的工具输出和出错的工具输出看起来完全一样（都是灰色代码块），用户无法区分。

---

### 排查点 5：重连/回放后用户消息不可见

**结论：已修复（Bug2），但修复是否完整待确认。**

TODO.md 第 3 行标注：Bug2 已在 commit `000687f` 中修复——server 把 user turn 存入 history，client 通过 nonce dedup 避免重复渲染。

当前代码实现（第 407–465 行）：
- `_handleUserEvent` 会检查 nonce（第 423–427 行）：本地发送的消息通过 nonce 去重，不重复渲染
- 历史回放（无 nonce）时：`c.type === 'text'` 的内容会调用 `_appendUserBlock(c.text)` 渲染

**潜在剩余问题**：`routes.js` 第 658–660 行，server 存入 history 的 user event 格式为：
```javascript
{ type:'user', message:{ role:'user', content:[{type:'text', text: msg.text}] }, _nonce: msg._nonce || null }
```

但如果 Claude 在回复过程中产生了 tool_use，随后的 user turn（包含 `tool_result` 的那一条）是 Claude CLI 自己管理的，server 不单独存入 history——这类 tool_result 只在 `assistant` 事件里作为 message 的一部分回放。这个逻辑是正确的，但如果 `assistant` 事件回放时 tool_result 本身被"吞掉"（排查点 3 的 bug），那重连后工具结果就真的消失了。

---

## 三、根因排序（按可能性）

### 根因 A（高概率）：tool_use 和 tool_result 完全解耦，没有配对关联

**文件**：`claude-block-renderer.js` 第 693 行 `_renderToolResultPart`

`tool_use_id` 字段从未被读取。tool_result 被渲染为独立的孤儿块，用户无法直观看出"这个结果属于哪个工具调用"。这是架构性缺陷，也是用户说"还是不对"的最核心问题——两个本应关联的块互相独立，交互体验混乱。

**修复方向**：渲染 tool_result 时，先用 `tool_use_id` 在 DOM 中查找对应的 tool_use 块（给 tool_use 块加 `data-tool-id="toolu_xxx"` 属性），然后把 tool_result 内容注入到对应 tool_use 块的 body 里（作为"输出"展示），而不是在末尾另起一个块。

---

### 根因 B（高概率）：非文本 tool_result 被静默吞掉

**文件**：`claude-block-renderer.js` 第 700–703 行

当 tool_result 的 content 是数组但没有 `type:'text'` 元素时（image、empty 等），整个块不渲染。用户看到工具调用了，但看不到任何结果——比完全没有结果更困惑。

**修复方向**：
- 对 image 类型：渲染 `<img>` 标签（base64 data URL）
- 对空结果：显示占位符（如"(no output)"）而不是直接 `return`
- 至少要保留块本身，不要静默消失

---

### 根因 C（中概率）：is_error 没有视觉区分

**文件**：`claude-block-renderer.js` 第 693 行 `_renderToolResultPart`

工具报错时用户看不出来是错误还是正常输出，调试工具执行问题时完全没有视觉线索。

**修复方向**：读取 `part.is_error`，为 error 状态添加红色边框/背景或错误图标，并加上 CSS 类 `cbr-tool-result--error`。

---

### 根因 D（低概率）：partial_message 中 tool_use 分片不显示进度

**文件**：`claude-block-renderer.js` 第 535 行

工具调用较慢时，用户在工具执行完成前看不到任何工具调用状态（`_handlePartialMessage` 跳过了 tool_use 分片）。这是 UX 问题而非功能缺陷。

**修复方向**：在 `_handlePartialMessage` 中检测到 `tool_use` 类型的 partial 时，也创建一个 live tool block，显示工具名称（即使 input 还不完整）并标记为"loading"状态。

---

## 四、总结

| 问题 | 严重度 | 根因 | 所在行 |
|------|--------|------|--------|
| tool_use 与 tool_result 没有配对，孤儿块 | 高 | 从未读 `tool_use_id` | 693 行 |
| 非文本 tool_result 被吞掉（image/empty） | 高 | `if (!text.trim()) return` | 702–703 行 |
| is_error 无视觉区分 | 中 | 从未读 `is_error` | 693 行 |
| tool_use 分片无进度显示 | 低 | `_handlePartialMessage` 跳过 | 535 行 |

Bug2（重连后用户消息不可见）在 commit `000687f` 中已修复，与 tool block 问题不同源。

---

## 五、阶段二新增根因（Subagent Visibility）

诊断时间：2026-06-03（阶段二补完）
验证方式：demo-toolblocks/index.html Scenario 6 + browse 截图

---

### 根因 E（高严重度）：subagent-prompt 初次渲染时折叠状态不确定

**文件**：`claude-block-renderer.js` 第 691–743 行 `_renderToolUsePart`

**行为**：
- 第 691 行：`const extraClass = isSubagentPrompt ? ' cbr-block-subagent-prompt' : ''`
- 第 693 行：创建 article，含 `cbr-block-subagent-prompt` 类
- **第 739–743 行（实际代码）**：
  ```javascript
  if (isSubagentPrompt) {
    article.setAttribute('data-fold', 'full')  // 739–740 行
  } else {
    applyToolFold(article)                       // 742 行
  }
  ```
- **第 715–717 行**：
  ```javascript
  if (isSubagentPrompt && !getSubagentPromptVisible()) {
    article.style.display = 'none'
  }
  ```

**现状评估**：当前实现在创建 subagent-prompt 块时确实已经执行了 `data-fold='full'`（第 739–740 行），prompt 内容默认可见。阶段一的诊断「没强制 full」已修复。但存在一个边缘场景：`setSubagentPromptVisible(true)` 被调用时（第 58–68 行），`querySelectorAll('.cbr-block-subagent-prompt')` 能找到已有块并再次 `setAttribute('data-fold','full')`。**这条路径是正确的。**

**实际问题残留**：`getSubagentPromptVisible()` 默认返回 `true`（第 53–56 行），所以 prompt 块**默认就不会被隐藏**。主人说「看不见交代了什么」可能指的是 **全局 fold 等级被设为 `header` 或 `line`** 时，subagent-prompt 块虽然有 `data-fold='full'`，但 CSS 选择器优先级的问题。

验证：CSS `applyToolFold` 函数（第 95–107 行）仅对 `!el.classList.contains('cbr-block-subagent-prompt')` 的元素生效——但实际上 `setToolFoldLevel` 里的 `querySelectorAll` 是 `.cbr-block-tool, .cbr-block-tool-result`（第 88 行），**不包含** `.cbr-block-subagent-prompt`，所以全局折叠**不会覆盖** subagent-prompt 块的 `data-fold='full'`。因此 E 的「折叠吞掉」方向在当前代码里已不成立。

**实际 E 根因（重新定位）**：`getSubagentPromptVisible()` 的 localStorage 键是 `cbr_subagent_prompt`，默认 `true`。但 `app.js` 里 `loadSubagentVisSettings()` 函数（第 522–527 行）只在某些时机被调用——若 checkbox UI 初始化时 localStorage 里有 `false`，则 prompt 块首次渲染就被隐藏（第 715–717 行）。UI checkbox（app.js 第 523 行）和 renderer 各自读 localStorage，没有单一 source of truth，主人切换 checkbox 后如果没有触发 `setSubagentPromptVisible`，状态会不一致。

**行号汇总**：第 53–56 行（getter）、第 58–68 行（setter + querySelectorAll）、第 715–717 行（渲染时隐藏）、第 739–740 行（fold=full）；app.js 第 523–527 行（UI 同步）、第 530–541 行（change 监听）。

---

### 根因 F（高严重度，核心架构 bug）：事件层 return 丢弃 DOM，toggle 变不可逆

**文件**：`claude-block-renderer.js`

**三处 gate（所有三处均有此问题）**：

| 行号 | 所在函数 | gate 代码 |
|------|---------|-----------|
| **437 行** | `_handleUserEvent` | `if (!getSubagentActivityVisible()) return` |
| **491 行** | `_handleAssistant` | `if (event.parent_tool_use_id && !getSubagentActivityVisible()) return` |
| **518 行** | `_handlePartialMessage` | `if (event.parent_tool_use_id && !getSubagentActivityVisible()) return` |

**机制剖析**：

```
事件流：WS → handleEvent → switch(type) → _handleUserEvent/_handleAssistant/_handlePartialMessage
                                                            ↓
                                        if (!getSubagentActivityVisible()) return   ← 437/491/518
                                                            ↓
                                        [EVENT PERMANENTLY DISCARDED — NO DOM BUILT]
```

**为什么 toggle 无效**：

`setSubagentActivityVisible(val)` 的实现（第 75–82 行）：
```javascript
function setSubagentActivityVisible(val) {
  localStorage.setItem(SUBAGENT_ACTIVITY_KEY, val ? 'true' : 'false')
  document.querySelectorAll('.cbr-block-subagent-activity').forEach((el) => {  // 78 行
    el.style.display = val ? '' : 'none'
  })
}
```

toggle 切换 ON 时，`querySelectorAll('.cbr-block-subagent-activity')` 去找已存在的块。但因为事件层 return，这些块从未被创建，**querySelectorAll 返回空 NodeList**，forEach 零次执行，toggle 看起来完全没有反应。

**不可逆性**：事件已经从 WS 流中流过，服务端不重放。除非重连触发 history replay（且 history 里存了 subagent 事件），否则这些事件永远丢失，**toggle 切 ON 无法找回**。

**对 prompt 开关的影响**：prompt 开关（`getSubagentPromptVisible`）在渲染时生效（第 715–717 行），prompt 块确实建了 DOM；所以 prompt toggle 能双向生效。**bug 只在 activity 开关**（437/491/518 行的 return）。

---

### 根因 F 修复方向（适配阶段二时改哪几行）

**原则**：永远不在事件层 return 丢弃事件。改为：**渲染时建 DOM，设 display:none，toggle 改 display**。

**需要改的地方**：

1. **第 437 行** `_handleUserEvent`：删除 `if (!getSubagentActivityVisible()) return`。
   改为：为 subagent activity 事件建 `.cbr-block-subagent-activity` 块，创建时判断是否隐藏：
   ```javascript
   const actBlock = this._makeBlock('cbr-block-subagent-activity')
   if (!getSubagentActivityVisible()) actBlock.style.display = 'none'
   ```

2. **第 491 行** `_handleAssistant`：删除 `if (event.parent_tool_use_id && !getSubagentActivityVisible()) return`。
   改为：渲染 subagent assistant 内容为 activity 块，创建时判断隐藏。

3. **第 518 行** `_handlePartialMessage`：同理删除 gate，partial_message 的 subagent 内容也按 activity 块渲染。

4. **第 78 行** `setSubagentActivityVisible` setter：不变，`querySelectorAll('.cbr-block-subagent-activity')` 现在能找到已有块了，因为事件层不再丢弃。

5. **`_makeBlock` 封装**（可选优化）：新增 `_makeActivityBlock(label, bodyHtml)` 辅助函数，自动带 `.cbr-block-subagent-activity` 类，避免散落。

---

### 阶段二适配风险点

| 风险 | 描述 | 缓解 |
|------|------|------|
| **流式状态混乱** | `_liveAssistantBlock`、`_liveAssistantId` 等 live 状态在 subagent assistant 事件进来时可能被清零，导致主 agent 的 live 块丢失 | 修改时用 `isSubagentAssistant` 分支，subagent assistant 走单独的 `_liveSubagentBlock` 状态，不触碰主 agent live 状态 |
| **tool_result 注入位置** | subagent 内部的 tool_use + tool_result 目前 tool_use 在 activity 块里，tool_result 用 `_renderToolResultPart` 注入，但 `_renderToolResultPart` 查的是 `this._scroll` 全局 DOM；若 subagent tool_use 和 main tool_use 有 id 冲突（不应有，id 全局唯一）可能注入错位置 | 问题不大（id 唯一），但建议 subagent tool_result 优先查 activity 区域 |
| **history replay** | 重连时 server replay 会把带 parent_tool_use_id 的 user/assistant 事件也放进去；删掉 return 后这些事件会被重复渲染 | 和主 agent 事件一样用 nonce dedup，或检查 history 里 subagent 事件是否有重复 |
| **`_liveToolBlocks`** | `_handlePartialMessage` 删 gate 后，subagent 内部的 tool_use partial 也会创建 loading 块；`_handleAssistant` 的清理逻辑（第 499–504 行）会把它们一并删掉 | 清理时检查 `parent_tool_use_id`，主 agent 的 `_handleAssistant` 只清理 **非** subagent 的 live tool 块 |
| **performance** | subagent 可能产生大量 partial_message 事件（每个 streaming chunk 一个），现在全部建 DOM；视 subagent 输出量可能导致大量 activity 块 | 可对 subagent partial text 做 live-update（复用同一个 activity 块），而不是每个 partial 新建一块 |

---

## 六、demo 正确做法 vs 现状 renderer 关键差异对照

| 维度 | demo-toolblocks 正确做法 | 现状 renderer（需改） |
|------|--------------------------|----------------------|
| 事件处理层 | 不在事件层 return；所有带 parent_tool_use_id 的事件都建 DOM | 437/491/518 行 return，事件永久丢弃 |
| 初始可见性 | 建 DOM 时根据 toggle 状态设 `display:none` | —（块不存在，无需设置） |
| toggle ON 效果 | `querySelectorAll('.subagent-activity-block')` 找到已有块，批量设 `display:''` | querySelectorAll 返回空，无效果 |
| toggle OFF 效果 | 同上，设 `display:'none'` | 下次事件到来时会 return，已有块不受影响（仍可见） |
| prompt 块 fold | `data-fold='full'` 在建块时设置，不受全局折叠覆盖 | 已正确（第 739–740 行），无需改 |
| subagent live state | 独立 `liveActivityBlock`，不触碰主 agent live 状态 | 无 subagent live state（因为直接 return） |

---

*阶段二根因 E/F 由诊断专员补完于 2026-06-03，不含对 nanocode 主代码的任何修改。*
