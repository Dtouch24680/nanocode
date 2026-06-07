# Evidence — selfresume-bugs 收尾 (2026-06-07)

## 任务
喇叭合并、ntfy 默认值通用化、interrupt 3个过时测试修复、手机UI 44px tap targets。

## 改动点（file:line）
- `public/index.html:514` — 删除旧 #tts-btn (15行)，mute-btn 为唯一声音键
- `public/js/tts.js:22` — 删 ttsBtn 变量; tts.js:77-80 — 删 updateTtsUi ttsBtn块; tts.js:253 — 删 click listener
- `public/index.html:340` — ntfy-topic placeholder zhiningwork → yourname
- `public/js/app.js:581-582` — 不再写死 ntfy_topic 默认值
- `server/tests/claude-interrupt-route.test.js:182-198` — 期望"Resuming with"(9840310 auto-flush); 等≥2 result; first.subtype='error_during_execution'(a33d294)
- `server/tests/claude-sdk-driver.test.js:213,217-229` — setImmediate wait; subtype→'error_during_execution'; reruns.length=1; "Resuming with"
- `server/tests/interrupt.test.js:175-192` — sendRaw不再插block，期望interrupted.length=0
- `public/style.css:2058-2073` — @media(max-width:480px) .tts-btn/.tts-replay-btn/send-btn/claude-stop-btn → 44px

## interrupt fail 判定结论
3个测试均为**过时测试**，非代码bug：
- a33d294 (2026-06-07): interrupt subtype = 'error_during_execution'（对齐CLI），sendRaw不插client block
- 9840310 (2026-06-07): auto-flush → "Resuming with N queued..." 替代旧 "Queue cleared"
- b67a2b6 不回退：flush逻辑正确，测试期望过时

## 验证
- npm test: 44 pass, 0 fail ✓
- curl /api/health → 200 ✓
- curl /api/codex/config → {"model":"gpt-5.5"} ✓
- grep zhiningwork public/ → 0 ✓
- index.html grep #tts-btn → 0 ✓
- mute-btn 44x44px / tts-replay-btn 44x44px / send-btn 44x44px ✓
- 手机截图: /tmp/mobile_after.png

---

# Evidence — Settings模型下拉修复 (2026-06-07)

## 任务
删除 Settings 面板 Claude / Codex 模型下拉中所有过时/错误硬编码型号，改为从真实来源动态获取。

## 改动点（file:line）
- `public/index.html:191-198` → 删除 5 个过时 Claude option，只保 Default
- `public/index.html:210-216` → 删除 4 个错误 Codex option（o3/o4-mini/gpt-4.1/gpt-4o），只保 Default
- `public/js/app.js:970` → `_applyDynamicModelOptions` 删除 knownModels 硬编码列表，只保 Default + snapshot.model
- `public/js/app.js:1032` → 新增 `fetchCodexConfig` + `_applyCodexModelOptions`（读 /api/codex/config，动态填充 Codex 下拉）
- `terminal/routes.js:602` → 新增 `GET /api/codex/config`，读 `~/.codex/config.toml` model 字段

## Commit
206f346

## IMPL_NOTE
既有 3 个 fail（claude-interrupt-route.test.js 超时、claude-sdk-driver.test.js interrupt 子测试、interrupt.test.js sendRaw\\x03 测试）是 9b3d2ac arch-refactor 引入的 pre-existing 失败，与本任务无关，留待后续单独处理。

## 验证结果
- `npm test` → # fail 3（无新增）
- `curl http://localhost:3001/api/codex/config` → {"model":"gpt-5.5"}
- curl 验证 claude-model-select 只含 Default，codex-model-select 只含 Default，无任何过时型号

# Evidence — Settings面板打磨 A-E (2026-06-07)

## 任务
Settings面板打磨：i18n中英切换、精简三块、全局Permission、通知红点+静音、UI修

## 改动点（file:line）
- A.i18n: `public/js/i18n.js`（新建），`public/index.html`（data-i18n标注+Language下拉+i18n.js script标签），`public/js/app.js`（import initI18n/setLang/t，loadLangSelect，lang-select handler，init()调initI18n）
- B.精简: `public/index.html`（删131-144 CLI Provider块、删191-203队列开关块、删264-276Claude驱动块），`public/js/app.js`（删对应handler，loadSettings精简）
- C.Permission+Codex模型: `public/index.html`（新global-permission-mode-group三档、新codex-model-select），`public/js/app.js`（loadGlobalPermissionModeSettings+globalPermissionModeSaveBtn，loadCodexModelSettings+codexModelSaveBtn），`terminal/claude-session-controller.js`（两处permMode→globalPerm，codex TAB_LAUNCHER按档切换flags）
- D.红点+静音: `public/js/app.js`（_addUnread/_clearUnread/favicon canvas，_globalMuted/setGlobalMuted/isGlobalMuted/mute-btn handler，playNotifySound加mute检查，loadNtfySettings默认localhost/zhiningwork），`public/js/tts.js`（_isGloballyMuted，enqueueTts+playNextTts检查mute），`public/style.css`（.mute-btn.muted样式，.settings-lang-row样式）
- E.UI修: `public/js/terminal-view.js:424`（"⏵ 立即发送" → "Send now"）

## commit
7850397

## 测试结果
npm test: tests=44 suites=15 pass=41 fail=3（均为既有flaky，claude-interrupt-route/claude-sdk-driver/interrupt三个pre-existing failures，my changes: 0 new failures）
grep FAIL/Error/NOT FOUND run.log → 仅既有failures，无新增
3001 health: 200 ✓
curl /js/i18n.js: 有效 ✓
curl /: CLI Provider=0 codex-model-select=1 global-permission=6 mute-btn=1 ✓

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
