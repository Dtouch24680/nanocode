# nanocode 查漏补缺优先级清单

审计日期：2026-06-06  
基于：nanocode_vs_official.md + block_rendering_opensource.md

---

## P0 — 必须修，影响正确性 / 会过期

### P0-1: slash 命令列表改为从 init 事件动态加载
- **Motivation：** 当前硬编码 30 条，实际 init 事件含 106 项（含所有 plugin slash 命令如 `codex:setup`、`ralph-loop:help`、`update-config`）。新 plugin 安装后 nanocode 菜单不更新，主人会漏掉可用命令。
- **位置：** `public/js/terminal-view.js:280-310`（`CLAUDE_SLASH_COMMANDS` 数组）；`public/js/claude-block-renderer.js:1099`（`_handleSystem init`）
- **方案：** `_handleSystem` 里存 `this._initSlashCommands`；`terminal-view.js` 从渲染器取而不是硬编码
- **估时：** 2h

---

## P1 — 高价值，中等改动，不影响正确性

### P1-1: Edit/Write tool_use 显示内联 diff，不再 JSON dump
- **Motivation：** 当前所有工具输入都是 `renderCode(JSON.stringify(...), 'json')`。Edit 工具有 `old_string`/`new_string`/`path`，Write 工具有 `file_path`/`content`，直接可渲染成两栏 diff。LibreChat/continue.dev 都有这个功能。
- **位置：** `public/js/claude-block-renderer.js:1417-1472`（`_renderToolUsePart`）
- **方案：** npm `jsdiff`（或简单的逐行 diff）；在 Edit/Write 分支渲染红绿行
- **估时：** 4h（含 CSS）

### P1-2: model 名、fast_mode、插件列表显示在 session init block
- **Motivation：** `init.model`（`"claude-opus-4-8[1m]"`）、`init.fast_mode_state`、`init.plugins[]` 都已在 init 事件中。当前只显示 `[Session xxx · N tools available]`，不显示 model，主人不知道跑的是哪个版本。
- **位置：** `public/js/claude-block-renderer.js:1099-1102`（`_handleSystem init`）
- **方案：** 扩展 `_addSystemBlock` 内容，一行显示 model + plugins 数
- **估时：** 0.5h

### P1-3: settings 面板加 model 选择 + effort 级别
- **Motivation：** `claude --model sonnet/opus/haiku` 和 `--effort low/medium/high/xhigh/max` 都是官方 flag，但 nanocode 的 `runClaudeTurn` 不传这些 flag，主人只能跑默认 model/effort。
- **位置：** `terminal/routes.js:1098-1107`（`launchArgs` 数组）；`public/js/app.js` settings 面板
- **方案：** settings 里加 model + effort 下拉，保存到 store，`TAB_LAUNCHERS.claude()` 读取追加
- **估时：** 2h

### P1-4: auth status 显示在 settings 面板
- **Motivation：** `claude auth status` 返回 `{loggedIn, authMethod, email, orgName, subscriptionType}`。主人偶尔会不确定哪个账号在跑，现在 nanocode settings 里没有任何账号信息。
- **位置：** `server/index.js`（新增 `/api/auth/status` 路由）；`public/js/app.js` settings 面板
- **方案：** 后端 `execFile('claude', ['auth', 'status', '--json'], ...)` → 前端展示
- **估时：** 1h

### P1-5: 完成的 assistant block 缓存 innerHTML，不再响应 rAF
- **Motivation：** 当前每个流式 chunk 都重跑 `marked.parse()`（仅 rAF 节流）。消息完成后 block 仍是普通 div，下次 scroll/DOM 操作可能触发不必要的重计算。opencode、open-webui 都有 freeze 策略。
- **位置：** `public/js/claude-block-renderer.js:1338-1353`（`_handleResult`）
- **方案：** `_handleResult` 时对 `_liveAssistantBlock` 执行 `el.dataset.frozen = '1'`，rAF 回调里跳过 frozen block
- **估时：** 1h

### P1-6: thinking block 独立显示（折叠）
- **Motivation：** claude 4 系列在 thinking 模式下会输出 `type: 'thinking'` content part。当前 nanocode `_renderContentPart` 只处理 text/tool_use/tool_result，thinking block 被静默跳过，主人看不到 extended thinking 内容。
- **位置：** `public/js/claude-block-renderer.js:1389-1398`（`_renderContentPart`）
- **方案：** 加 `thinking` type 分支，渲染为可折叠的淡色 block（类似 subagent-activity 的 toggle）
- **估时：** 2h

---

## P2 — 中价值，较大工程量

### P2-1: tool_use 图标映射
- **Motivation：** LibreChat/siteboon 都有按工具名显示图标（Bash 用 terminal 图标，Read 用文档图标，WebSearch 用搜索图标）。当前 nanocode 只显示工具名文字。
- **位置：** `public/js/claude-block-renderer.js:1484-1490`（`_renderToolUsePart` header）
- **方案：** 建一个 `TOOL_ICONS` map（SVG inline 或 CSS class），`init.tools[]` 可验证工具名
- **估时：** 3h

### P2-2: Shiki 替换 highlight.js（代码高亮升级）
- **Motivation：** highlight.js 语言支持上限 ~200 种，且对 Rust/WGSL/TOML/MDX 支持较弱。Shiki 用 VS Code 的 TextMate grammar，支持 500+ 语言，输出 HTML 更准确。vercel/streamdown 默认用 Shiki。
- **位置：** `public/js/claude-block-renderer.js:198-215`（`renderCode`）；`public/index.html:40`（vendor 引入）
- **方案：** `shiki/browser` 包（~80KB gzipped），异步初始化后替换 hljs 调用；highlight.js 可保留作 fallback
- **估时：** 3h

### P2-3: mermaid.js 集成（图表渲染）
- **Motivation：** Claude 经常输出 mermaid 流程图（架构图、序列图、状态机）。当前 nanocode 只渲染成 code block，不执行图表。open-webui/LibreChat 都支持。
- **位置：** `public/js/claude-block-renderer.js:198-215`（`renderCode`）
- **方案：** lazy load `mermaid.js`，code block lang=mermaid 时转 SVG
- **估时：** 3h（含 mobile 适配）

### P2-4: image inline 渲染（tool_result 中的 image block）
- **Motivation：** Claude 的 Computer Use 工具会返回截图（base64 image）；WebSearch 工具偶尔返回图片。当前 nanocode `_renderToolResultPart` 不处理 image content type。
- **位置：** `public/js/claude-block-renderer.js:1592-1700`（`_renderToolResultPart`）
- **方案：** content item `type === 'image'` → `<img src="data:..." class="cbr-inline-img">`
- **估时：** 1.5h

### P2-5: 工具权限 UI（opt-in，非强制）
- **Motivation：** sugyan/claude-code-webui 和 siteboon/cloudcli 都有 per-tool 权限控制。nanocode 当前一律 `--dangerously-skip-permissions`，主人无法审查工具调用。
- **位置：** `terminal/routes.js:791-808`（`TAB_LAUNCHERS.claude`）；WS 消息协议
- **方案：** settings 里加 `permission_mode` 选择（auto / bypassPermissions / acceptEdits）；bypass 为默认
- **估时：** 4h

### P2-6: KaTeX 数学公式渲染
- **Motivation：** 当 Claude 回答数学推理时会输出 LaTeX（`$...$` 或 `$$...$$`）。当前 marked 不处理 LaTeX，直接显示源码。
- **位置：** `public/js/claude-block-renderer.js:159-215`（renderMarkdown + renderCode 之后）
- **方案：** lazy load KaTeX，post-process rendered HTML 替换 math spans
- **估时：** 3h

---

## P3 — 低优先级，长尾

### P3-1: 流式 code block closing-backtick guard
- **Motivation：** 当 streaming 进行中遇到未闭合的 ` ``` ` 时，marked.parse 会把剩余内容当成 code block 内容，导致排版错误。open-webui 的 fix：检测 raw token 是否包含 closing backticks 再决定是否 parse。
- **估时：** 2h

### P3-2: 完成 block 的 rAF scroll 优化（避免 layout thrashing）
- **Motivation：** 每次 `_scrollBottom()` 都触发 `scrollTop = scrollHeight`，可能导致连续多个 block 同帧 layout thrash。可改为 requestAnimationFrame 合并。
- **估时：** 1h

### P3-3: session name 显示（`--name` flag）
- **Motivation：** claude CLI 有 `--name` flag（`-n`），可给 session 命名（显示在 /resume picker 里）。nanocode 不传 `--name`，session 只有 UUID。
- **位置：** `terminal/routes.js:1098`（launchArgs）
- **方案：** 用 tab.label 做 `--name`，让 session 在 claude 的 /resume 列表里有可读名字
- **估时：** 0.5h

### P3-4: thinking_tokens 实时 token 计数显示
- **Motivation：** `system/subtype=thinking_tokens` 事件实时推送 `estimated_tokens`，可做右下角 token 计数器。
- **估时：** 1.5h

### P3-5: `--fork-session` 按钮
- **Motivation：** 允许用户从历史 session 分叉出新分支（保留历史不污染），claude 已支持 `--fork-session`。
- **估时：** 2h

---

## 总工作量估算

| 级别 | 条数 | 总估时 |
|---|---|---|
| P0 | 1 | 2h |
| P1 | 6 | 11.5h |
| P2 | 6 | 18.5h |
| P3 | 5 | 7h |
| **合计** | **18** | **~39h** |
