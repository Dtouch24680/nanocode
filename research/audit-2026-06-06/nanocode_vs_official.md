# nanocode 自实现 vs 官方等价物 对照表

审计日期：2026-06-06
审计分支：`zhining/nanocode-selfresume-bugs`
基于 claude CLI v2.1.162 + stream-json init 事件真实字段

---

## 关键发现：init 事件完整字段

通过实际运行 `claude --print --output-format=stream-json` 捕获，`system/subtype=init` 事件包含以下字段：

```
type, subtype, session_id, cwd, model, permissionMode, apiKeySource,
tools[],          ← 30+ 工具名（Task/Bash/Read/Write/WebFetch...）
mcp_servers[],    ← {name, status}
slash_commands[], ← 完整 slash 命令列表（106 项，含 plugin/user 自定义）
agents[],         ← 配置的 agent 名（"claude","codex:codex-rescue"...）
skills[],         ← 完整 skill 列表（88 项）
plugins[],        ← {name, path, source} 数组
memory_paths,     ← {auto: "~/.claude/projects/.../memory/"}
fast_mode_state,  ← "off"/"on"
claude_code_version, output_style, analytics_disabled, ...
thinking_tokens*  ← 独立 system 事件（subtype=thinking_tokens）
```

---

## 对照表

| # | nanocode 自实现 | 位置（file:line） | 官方/SDK 等价物 | 切换难度 | 收益 |
|---|---|---|---|---|---|
| 1 | **slash 命令硬编码 30 条** | `public/js/terminal-view.js:280-310` `CLAUDE_SLASH_COMMANDS` 数组 | `init.slash_commands[]`（106 项，含 plugin 命令如 `ralph-loop:help`、`superpowers:brainstorming`） | 低：监听 init 事件写入动态列表 | 高：永远与 claude CLI 版本同步，plugin 命令自动出现 |
| 2 | **session GC：nanocode 自己扫 PID** | `terminal/routes.js:1008-1032` `gcClaudeSessions()` 读 `~/.claude/sessions/*.json`，`process.kill(pid,0)` 判死亡 | claude 自带 session 清理；`claude agents --json` 可列出当前所有活跃 session（含 pid/sessionId/status）；`--no-session-persistence` 跳过持久化 | 中：可用 `claude agents --json` 辅助判断 session 是否活跃，减少误判 | 中：减少手动维护 lock 文件的风险 |
| 3 | **jsonl 读取：nanocode 自己 parse `~/.claude/projects/**/*.jsonl`** | `terminal/routes.js:326-582`（`cwdToClaudeProjectDir`、`parseJsonlHistory`、`findNewestJsonl`） | claude 官方 `--resume <sessionId>`/`--continue` 会自己加载历史；jsonl 格式无官方解析 SDK，但 `claude project` 提供 `purge` 子命令。无官方 query-sessions API | 不可切换（无官方 history query API）| N/A — 只能改进自实现稳定性 |
| 4 | **工具列表不使用 init.tools** | `public/js/claude-block-renderer.js:1099-1102`：只读 `event.tools.length` 显示数字，不存储工具名 | `init.tools[]` 已含所有 30+ 工具名，可用于 UI 显示"今日可用工具"徽章或 tool_use block 图标映射 | 低：保存 `_initTools` 集合后在 `_renderToolUsePart` 里查图标 | 低：改善 tool block 可读性 |
| 5 | **agents 列表：nanocode 自维护 `server/agents-config.json`** | `server/index.js:281-368` `agentsConfig`、`/api/agents` 路由；`public/js/agents.js` | `init.agents[]` 已返回 claude 侧配置的 agent（`["claude","codex:codex-rescue","Explore","general-purpose","Plan","statusline-setup"]`） | 中：nanocode 的 agents 是"tmux 窗口监控"，init.agents 是"claude 子 agent 配置"，两者用途不同，不能直接替换，但可互相补充 | 中：自动展示 claude 侧 agent 列表，不需手动配置 |
| 6 | **skills 列表：前端无感知** | `public/js/terminal-view.js:280-310` slash_commands 里只有 /help 等，无 skill 名 | `init.skills[]` 含 88 个 skill 名（与 slash_commands 的用户可见部分对应）；`init.slash_commands[]` 是完整可触发列表 | 低：从 init 事件存入后在 slash 下拉里展示 plugin skill（如 `codex:setup`、`update-config`） | 高：slash 菜单完整性，不再漏 plugin 命令 |
| 7 | **mcp_servers 列表：无 UI 显示** | 未找到 mcp 展示代码 | `init.mcp_servers[]`（`{name, status}`）已在 init 事件中 | 低：在 init system block 里显示 connected MCP 服务器 | 低：透明度提升 |
| 8 | **model 名：从 init 读但只计数** | `public/js/claude-block-renderer.js:1099-1102`：读了 `event.tools` 但未读 `event.model` | `init.model` 即 `"claude-opus-4-8[1m]"` — 当前实际使用的 model | 低：在 session init block 显示 model 名 | 低：用户可知当前 model |
| 9 | **memory_paths：nanocode 无感知** | 无 | `init.memory_paths.auto` = `"~/.claude/projects/.../memory/"` | 低：可在 session info block 里显示路径 | 低 |
| 10 | **fast_mode_state：nanocode 无 UI** | `server/index.js`：无 fast_mode 相关路由 | `init.fast_mode_state`（`"off"`/`"on"`）；claude CLI 有 `/fast` slash 命令 | 低：将 fast_mode 状态显示在 session info 里 | 低 |
| 11 | **session 续接：nanocode 用 `--session-id` + `--resume`** | `terminal/routes.js:1093-1096`：第一轮 `--session-id=UUID`，后续 `--resume=UUID` | claude 支持 `--continue`（简写 `-c`，续接当前目录最新 session）、`--resume <id>`、`--fork-session`（续接但用新 UUID）；nanocode 目前没有用 `--fork-session` | 中：增加 `--fork-session` 按钮，让用户从某 session 分叉出新分支 | 中：UI 上的"分叉会话"功能 |
| 12 | **recent-agents 实现：nanocode 自扫 jsonl** | `terminal/routes.js:585-771`，自己读 `~/.claude/projects/*/` | `claude agents --json` 能返回当前活跃 session（pid/cwd/status），但**不**返回历史 session；历史 session 无官方 API | 不可切换（官方只列活跃 agent，历史仍需读 jsonl） | N/A |
| 13 | **hook 事件：nanocode 丢弃** | `public/js/claude-block-renderer.js:1103-1105`：`hook_started`/`hook_response` 明确 no-op | claude 的 `SessionStart`/`PostToolUse`/`PreToolUse`/`Stop` hook 事件通过 stream-json 流出；可在 init block 附近显示 hook 执行状态 | 低：可选 debug 模式下展示 | 低：对 agent 调试有价值 |
| 14 | **plugin 系统：nanocode 无** | 无 plugin 加载机制 | `claude plugin` 子命令管理插件，`init.plugins[]` 列出已加载插件（`{name,path,source}`）；`--plugin-dir` / `--plugin-url` flag | 高：完全不同的扩展方向；nanocode 可展示 init.plugins 列表，但不需要自己实现 plugin 系统 | 低（展示）/ 高（若做 nanocode 原生扩展） |
| 15 | **auth/token：nanocode 无管理** | 无相关代码；auth 目录在 `server/auth/`（系统模式专用，单用户模式未实现） | `claude auth login/logout/status`；`claude auth status` 返回 `{loggedIn,authMethod,email,orgName,subscriptionType}`；`--bare` flag 强制 ANTHROPIC_API_KEY 模式 | 中：`server/index.js` 可增加 `/api/auth/status` 代理到 `claude auth status --json` | 中：可在 settings 里显示当前账号状态 |
| 16 | **debug 日志：nanocode 自写 nanocode-3001.log** | `server/index.js` `console.*` 直接输出；PM2 管理日志文件 | `claude --debug-file <path>` 写 claude 自身 debug；`claude --debug` 控制台；两套日志独立 | 低：无法合并，但可在 settings 里显示 claude --debug 入口 | 低 |
| 17 | **stream-json 协议解析：全手写** | `public/js/claude-block-renderer.js` 全文（1730 行）处理 assistant/partial_message/tool_use/tool_result/result/system/rate_limit_event 等 | 官方文档见 https://code.claude.com/docs/en/headless；无官方 typed parser 库；社区有 takopi stream-json cheatsheet | 不切换（无官方 parser 可用）；但可参考官方文档校正遗漏 event types | 中：确保覆盖全部 event subtype |
| 18 | **`thinking_tokens` 事件：nanocode 未处理** | `public/js/claude-block-renderer.js`：未见 `thinking_tokens` case | `system/subtype=thinking_tokens`：`{estimated_tokens, estimated_tokens_delta}` 实时 token 预估；可做 token counter | 低：在 session info 块显示实时预估 tokens | 低 |
| 19 | **`--effort` flag：nanocode 无 UI** | 无相关路由或 setting | `claude --effort low/medium/high/xhigh/max`；`init` 事件无 effort 字段（flag 只影响 API 请求） | 中：在 settings 面板加 effort 选择，传给 `runClaudeTurn` 的 `launchArgs` | 中：让用户控制 thinking depth |
| 20 | **`--model` flag：nanocode 无 UI**（Codex 已移除，Claude 从未有） | `public/js/app.js:336-337`（注释说已删） | `claude --model sonnet/opus/haiku` 或 `/model` slash | 低：可在 settings 或 slash dropdown 里加 model 切换按钮，追加到 `launchArgs` | 中：主人可能需要切 sonnet vs opus |
| 21 | **`/resume` 拦截：nanocode 自实现** | `terminal/routes.js:1326-1355`：拦截文字 `/resume`，手动路由到最近 session | claude `--print` 模式下 `/resume` 不可用（官方已知限制）；nanocode 的 workaround 是正确的 | 不切换（workaround 仍需要） | N/A |

---

## 总结：优先级最高的替换

1. **slash_commands（item 1）** — 已确认 init 事件带 106 项，nanocode 硬编码 30 条。P0。
2. **model 名显示（item 8）** — init.model 直接可用，改一行代码显示在 session block。P1。
3. **fast_mode / effort / model flag（item 10/19/20）** — settings 里加三个选项，追加到 launchArgs。P1。
4. **auth status（item 15）** — 一个 API 调用能显示当前账号信息。P1。
5. **agents/skills 展示（item 5/6）** — init 事件已有数据，加进 slash 菜单。P1。
