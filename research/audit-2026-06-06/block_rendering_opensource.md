# Block 渲染开源参考调研

审计日期：2026-06-06

---

## 当前 nanocode 状态（基线）

| 功能 | 现状 |
|---|---|
| Markdown 渲染 | `marked.js` v15 + `DOMPurify` v3（`public/js/claude-block-renderer.js:159-195`） |
| 代码高亮 | `highlight.js` v11，加载 `/vendor/highlight/highlight.min.js`（index.html:40） |
| 流式渲染 | rAF throttle：每帧最多一次 `marked.parse()`（`claude-block-renderer.js:1315-1334`） |
| tool_use 折叠 | 3 状态循环（full/header/line），localStorage 持久化 |
| tool_result | 内联到 tool_use 卡片 |
| thinking 块 | 未见独立 thinking block（仅 partial_message 处理） |
| Edit/Write diff | 无：tool_use 输入只是 JSON dump（renderCode JSON） |
| image inline | 无 |
| mermaid | 无 |
| katex/LaTeX | 无 |
| 表格 | 依赖 marked 的 GFM 支持（基本可用） |
| checklist toggle | 无 |
| cited references | 无 |
| ANSI 颜色 | bash tab 走 xterm.js；block 模式下 stderr 是纯文本，无 ANSI 解析 |
| 流式未完成 block 样式 | `cbr-live` CSS class + rAF |

---

## 1. claude.ai 官方 Web（官方参考）

**URL：** https://claude.ai（闭源，无 GitHub）

**block 渲染亮点：**
- 使用 **micromark** 作为底层 Markdown 解析器（流式友好，增量 tokenizer）
- 流式中 code block 未闭合时用占位样式，不报错
- thinking block（`<thinking>` 标签）单独折叠展示
- Edit/Write diff 有专属三栏 diff 视图（原文 / 变更 / 新文）
- tool_use 卡片有图标、折叠、loading 动画
- image 内联展示（包括 base64 和 URL）
- 引用气泡（citations）带上标数字
- KaTeX 数学渲染
- artifact（代码可运行预览）
- 表格可全屏展开

**nanocode 缺什么：**
- Edit/Write diff 视图（nanocode 只 JSON dump tool input）
- thinking block 视觉独立
- image inline
- katex
- 流式未完成 code block 不乱排版

**切换成本：** 不适用（闭源），仅供 UI 模式参考。

---

## 2. LibreChat（github.com/danny-avila/LibreChat）

**GitHub：** https://github.com/danny-avila/LibreChat  
**Stars：** ~28k（2026/06）  
**技术栈：** React + TypeScript + Tailwind

**block 渲染亮点：**
- React Markdown + remark/rehype 插件链，支持 GFM、数学、表格
- v0.8+ 将 artifact 渲染改为静态 HTML（避免 React 重渲染 + innerHTML 冲突）
- **重新设计的 Tool Call UI**：Contextual Icons、Smart Grouping、Rich Output Rendering（2025 changelog）
- 代码块带语言标签 + copy 按钮 + syntax highlight（Prism.js）
- 流式中 Markdown 增量渲染，code block 流式友好（不乱排版）
- MCP tool 渲染支持结构化输出（JSON/表格/图像）

**nanocode 缺什么：**
- Tool Call 分组（同一轮多个 tool_use 有 Smart Grouping）
- 结构化工具输出 Rich Rendering（非 JSON dump）
- 代码块 copy 按钮有（nanocode 也有），但语言检测更准

**切换成本：** 高（React 技术栈，整个前端需重写）；可参考其 tool-call 分组 UI 设计。

---

## 3. Open WebUI（github.com/open-webui/open-webui）

**GitHub：** https://github.com/open-webui/open-webui  
**Stars：** ~82k（2026/06）  
**技术栈：** SvelteKit + Python backend

**block 渲染亮点：**
- **Markdown 渲染管线（5.3 markdown-processing）**：`marked.js`（与 nanocode 相同）+ 自定义 renderer
- **流式安全代码块**：当 token 到达时检测 closing backticks，防止提前渲染
- 代码块 `data-language` 和 copy/edit 按钮
- mermaid.js 图表渲染（内置）
- KaTeX 数学公式（内置）
- 表格可全屏展开 + CSV 导出
- 思考链 (`<think>`) 折叠（已知有 bug：折叠会遮挡后续文本，issue #9233）
- 图像 inline 展示（工具输出图像直接显示）

**nanocode 缺什么：**
- mermaid 图表
- KaTeX
- 流式 code block 的闭合检测（nanocode 用 rAF 节流，但未做 closing-backtick guard）
- 表格 CSV 导出

**切换成本：** 高（Svelte 技术栈）；**直接借鉴其 closing-backtick 流式 guard 逻辑**可落地到 nanocode，成本低。

---

## 4. continue.dev（github.com/continuedev/continue）

**GitHub：** https://github.com/continuedev/continue  
**Stars：** ~25k（2026/06）  
**技术栈：** VS Code Extension（React webview）

**block 渲染亮点：**
- **Edit diff 渲染**：文件内联三列 diff（Accept/Reject 按钮）；这是 nanocode 最缺的功能
- tool_use 渲染带工具图标（Bash/Read/Write 有专属图标）
- thinking block 单独展示（extended thinking 支持）
- 代码块 "Apply" 按钮（将代码片段应用到当前文件）
- 流式 Markdown 增量渲染（remark + custom streamer）

**nanocode 缺什么：**
- Edit/Write diff 可视化是最大缺口；continue 的做法：解析 tool_use 的 `old_string/new_string`/`file_path` 字段，生成内联 diff
- "Apply" 一键应用代码片段

**切换成本：** 不可直接移植（VS Code Extension），但 diff 生成逻辑（`jsdiff` 库）可单独抽取。

---

## 5. aider（github.com/Aider-AI/aider）

**GitHub：** https://github.com/Aider-AI/aider  
**Stars：** ~32k（2026/06）  
**技术栈：** Python TUI（rich + click）

**block 渲染亮点：**
- terminal 内 Markdown 渲染（rich.markdown）
- 编辑操作用 `SEARCH/REPLACE` 块展示，diff 直观
- 颜色 diff：红删绿增，在终端里也清晰
- `/voice` 命令（类似 nanocode 的 TTS）

**nanocode 缺什么：**
- 对于 block renderer（web）参考价值有限（TUI）
- `SEARCH/REPLACE` 格式与 claude 的 `old_string/new_string` 概念相同，可参考 diff 渲染思路

**切换成本：** 不可移植（Python TUI），参考 UX 概念。

---

## 6. sugyan/claude-code-webui

**GitHub：** https://github.com/sugyan/claude-code-webui  
**Stars：** ~675（2026/06）  
**技术栈：** React（Vite）+ Deno/Node backend，TypeScript

**block 渲染亮点：**
- 与 nanocode 最接近的同类项目（同样包 claude CLI stream-json）
- 用 **SSE** 而非 WebSocket 传流
- `useClaudeStreaming` hook 处理 tool 权限（grant/deny per-session）
- 有 tool 权限 UI（三种模式：default/plan/acceptEdits）
- 代码高亮用 `highlight.js`（与 nanocode 相同）
- shared/types.ts 定义完整的 stream-json event types（可直接参考 TypeScript 类型）

**nanocode 缺什么：**
- nanocode 无工具权限 UI（用 `--dangerously-skip-permissions` 一刀切）
- 该项目有 plan 模式入口

**切换成本：** 可参考其 TypeScript event type 定义来完善 nanocode 的 event 覆盖；成本低（同语言，同协议）。

---

## 7. siteboon/claudecodeui（CloudCLI）

**GitHub：** https://github.com/siteboon/claudecodeui  
**Stars：** ~400（2026/06）  
**技术栈：** React（Vite + Tailwind）+ Express + SQLite

**block 渲染亮点：**
- plugin 系统（自定义 tab + Node.js backend）
- 自适应 mobile/tablet/desktop
- 交互式文件树 + syntax highlight live edit
- 多 session 管理
- 国际化（i18n）

**nanocode 缺什么：**
- nanocode 无 plugin 系统
- nanocode 无文件树 live edit（有 explorer，但只读）
- nanocode 无 i18n（中文硬编码）

**切换成本：** 高（整个前端框架不同）；参考其 plugin tab 设计。

---

## 8. opencode（github.com/opencode-ai/opencode）

**GitHub：** https://github.com/opencode-ai/opencode  
**Stars：** ~15k（2026/06）  
**技术栈：** Go + TUI（bubbletea）

**block 渲染亮点：**
- 差异化渲染（differential rendering）：只重绘变化的 TUI 组件
- 组件缓存：fully-streamed 的 assistant 消息不再重新 parse Markdown
- 已知痛点：**tool 渲染是 hardcoded switch block**（issue #21018），无法通过 plugin 自定义
- JSON code block 有 quote stripping bug（issue #8222）

**nanocode 缺什么：**
- 组件级缓存（nanocode 的 rAF throttle 是全量 `marked.parse()`，完成后没有 cache）
- 对 nanocode 的启示：对已完成的 assistant block 可以 freeze innerHTML，不再响应 rAF

**切换成本：** 不可移植（Go TUI），但缓存策略可借鉴。

---

## 9. vercel/streamdown

**GitHub：** https://github.com/vercel/streamdown  
**技术栈：** React（drop-in for react-markdown）

**亮点：**
- 专为 AI 流式 Markdown 设计，支持未完成 block（无需等 closing ```）
- 双引擎：**marked** 或 **micromark**（一行配置切换）
- 内置 Shiki 代码高亮（比 highlight.js 更准确，支持更多语言）
- 内置 KaTeX（LaTeX inline + block）
- GFM（GitHub Flavored Markdown，表格、checklist）
- 流式动画（staggered streaming）
- Tailwind typography styles

**nanocode 缺什么：**
- nanocode 无 Shiki（用的是 highlight.js）
- nanocode 无 KaTeX
- nanocode 无流式未完成 block 动画

**切换成本：** 中（需要 React 或自己从 streamdown 提取 core 逻辑）；**可以只借用其 Shiki 集成思路**，用 shiki/browser 替换 highlight.js，成本低且收益高（更多语言支持）。

---

## 10. 流式 Markdown 库对比

| 库 | 流式友好 | 代码高亮 | 数学 | 大小 | nanocode 适配成本 |
|---|---|---|---|---|---|
| **marked v15**（当前）| 一次 parse，rAF 节流 | 需外部 hljs | 无 | ~50KB | 0（已有） |
| **micromark** | 增量 tokenizer，流式最友好 | 无内置 | 无 | ~30KB | 中（需替换 renderMarkdown） |
| **markdown-it** | 整体 parse | 需外部 hljs | 插件支持 | ~60KB | 低（API 相似） |
| **streamdown**（vercel）| 专为流式设计 | Shiki 内置 | KaTeX 内置 | ~200KB | 高（React only） |
| **remark-react**（mdast）| 中 | 插件 | 插件 | ~100KB | 高（React）|

**推荐：** 短期维持 marked；中期可引入 **shiki/browser**（独立包）替换 highlight.js，带来更好的语言覆盖（Haskell/Rust/WGSL 等）。

---

## 11. Edit/Write Diff 渲染专项

nanocode 当前：`_renderToolUsePart` 对 Edit/Write 工具只做 JSON dump（`renderCode(JSON.stringify(part.input), 'json')`）。

建议参考方案（基于 `jsdiff` npm 包，1 KB gzipped）：

```
当 tool_name === 'Edit' 时：
  1. 解析 part.input.old_string + new_string
  2. diff = Diff.createPatch(path, old_string, new_string)
  3. 渲染成两栏：红色删除行 + 绿色新增行
  4. 折叠为单行（显示文件名 + ±行数）

当 tool_name === 'Write' 时：
  1. 整文件新增，显示 +N lines 徽章
```

现有折叠机制（cbr-tool-fold-btn）可直接复用，只需在 `_renderToolUsePart` 里加 Edit/Write 的 diff 分支。

---

## 12. 缺失功能汇总（对标竞品）

| 功能 | nanocode | sugyan/claude-code-webui | siteboon/cloudcli | LibreChat |
|---|---|---|---|---|
| Edit/Write diff 视图 | 缺 | 缺 | 缺 | 有 |
| tool_use 图标 | 缺 | 缺 | 有 | 有 |
| thinking block | 缺 | 缺 | 有 | 有 |
| image inline | 缺 | 缺 | 有 | 有 |
| mermaid | 缺 | 缺 | 有 | 有 |
| KaTeX | 缺 | 缺 | 缺 | 有 |
| 工具权限 UI | 缺 | 有 | 有 | N/A |
| 流式 code block 保护 | 部分（rAF） | 有 | 有 | 有 |
| 完成 block 缓存 | 缺 | 有 | 有 | 有 |
| plugin/tab 扩展 | 缺 | 缺 | 有 | 有 |
