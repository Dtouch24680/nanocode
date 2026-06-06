# Evidence — 打断交互收口 (2026-06-04)

## 任务
收口"打断交互对齐CLI"：CLI风格强提示block + 悬空_interruptingAt引用清除

## 改动文件
- public/js/terminal-view.js: 删 line:377 `_interruptingAt = null`（ReferenceError）；doInterrupt() 调 showInterruptBlock()
- public/js/claude-block-renderer.js: 新增 showInterruptBlock()（文案"[Request interrupted by user]"，CLI原文）；sendRaw('\x03') 改调 showInterruptBlock()
- public/style.css: 新增 .cbr-block-interrupted 左侧色条样式
- server/tests/interrupt.test.js: 新增 8条测试（DOM stub + grep双验证）

## CLI文案出处
`strings ~/.local/share/claude/versions/2.1.162` → `[Request interrupted by user]`（Claude CLI binary内嵌字符串）

## commit
effc79f fix: 打断交互对齐CLI——插入[Request interrupted by user]强提示block、清除悬空_interruptingAt引用

## 测试结果
npm test 24/24 pass, # fail 0（新增8条，原16条全过）

## 热更新验证
curl http://localhost:3001/api/health → {"status":"ok"}
curl .../js/claude-block-renderer.js | grep "Request interrupted by user" → 2匹配
curl .../js/terminal-view.js | grep "_interruptingAt" → 0匹配

---
# Evidence — 打断/按键bug修复 P0-1~P0-4

## 任务
1. P0-1: Esc打断逻辑（优先级队列，bash tab发\x1b）
2. P0-2: Ctrl+C对齐CLI（有字清空，空时调interrupt API）；ClaudeBlockRenderer.sendRaw改为真正调interrupt API
3. P0-3: 强打断（Stop显示interrupting状态；3s内再按force=1 SIGKILL；后端支持?force=1）
4. P0-4: touch toolbar @media(pointer:coarse) 显示

## commit
eb07a8a fix(P0): Esc/Ctrl+C打断语义对齐CLI + touch toolbar修复 + Stop按钮interrupting状态 + 后端force=1升级

## 测试结果
npm test 16/16 pass, # fail 0

```
# tests 16
# suites 2
# pass 16
# fail 0
```

## 热更新验证
- curl http://localhost:3001/ → HTTP 200
- curl http://localhost:3001/js/terminal-view.js | grep -c "doInterrupt|FORCE_WINDOW_MS|interrupting" → 19
- curl http://localhost:3001/js/claude-block-renderer.js | grep -c "interrupting|interrupt" → 3
- curl http://localhost:3001/style.css | grep -c "pointer: coarse" → 1

---

# Evidence — Agent Toolbar + Services Config Enhancement

## 任务
1. 右侧 Agent 管理工具栏（第三次，有 run.log）
2. Settings 端口监控增强（第三次，有 run.log）

## 验证方式

### API 验证（服务器在线）
```
GET /api/agents         → [] (空列表，可增删)
GET /api/agents/discover → 8个 tmux 窗口，含 claude 类型正确识别
PUT /api/agents         → 持久化到 agents-config.json
GET /api/services-config → services 5条 + localIPs 5个 IP
GET /api/services       → dccpipeline:up nanocode:up 其余 down
PUT /api/services-config → 持久化到 services-config.json
```

### 测试
```
npm test → 16/16 pass, fail 0
grep -i "FAIL|Error|NOT FOUND" run.log → "# fail 0" (干净)
```

### 功能清单
**Agent 工具栏：**
- ✓ agents.js: initAgentDrawer() — 抽屉开关、增删改、discover 按钮
- ✓ /api/agents GET/PUT — 状态 + 持久化
- ✓ /api/agents/discover — tmux 扫描 + 类型识别
- ✓ 最近会话(recent-agents)集成、一键 resume
- ✓ HTML 抽屉 + CSS 动画、移动端适配

**Services 增强：**
- ✓ 显示本机 IP（services-local-ip）
- ✓ 增/删/改监控项（svc-add-form + edit/del 按钮）
- ✓ /api/services-config GET/PUT 持久化
- ✓ 默认5条预填，最后检查时间显示

## Commit
eea3f17 — 自续接三连修（同次提交的 self-resume 修复）

## 热更新
PORT=3001 新进程启动确认 health 200 ✓
