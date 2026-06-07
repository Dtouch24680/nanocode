# Work Log

## 2026-06-07 [light mode 完整配色]
- 任务：实现 light mode 完整配色，修复切换机制 bug，覆盖所有面板
- 机制修复：theme.js applyTheme() 改用 setAttribute('data-theme','light') 替代 removeAttribute，[data-theme="light"] CSS 规则正确生效
- CSS 变量：style.css 新增 [data-theme="light"] 显式块，镜像 :root 浅色值，确保属性选择器优先级对称
- 覆盖组件：settings-panel、agent-drawer、TTS 按钮、service 健康状态、diff colors、subagent badge — 全部从硬编码暗色 fallback（rgba(255,255,255,0.x)）改为 var(--token) 覆盖
- 测试：新增 server/tests/theme-regression.test.js，验证 setAttribute 机制/默认 dark/CSS 选择器；全 69 tests pass，0 fail
- 截图验收：landing/project-picker/workspace/settings/agent-drawer/mobile 均呈浅色；dark mode 零回归（settings-panel 暗色确认）
- commit: d744205，push fork zhining/nanocode-selfresume-bugs

## 2026-06-07 13:40 [修复桌面端 busy 发消息不入队/滚走]
- 任务：桌面端 Claude busy 时发消息，队列框不显示、消息直接滚走（期望对齐手机端/CLI：忙时入队列框留着）。分支 zhining/nanocode-selfresume-bugs。
- 复现（桌面视口 1280x860，Playwright 真模拟键盘/事件链）：
  - 同会话本地 echo 路径正常（msg1 sendInputWithEcho→thinking=true→msg2 入队，排队中(1) 出现）。
  - **失败路径 = 刷新/重连后正在 busy 的 turn**：reload 后 chat-input 没有 claude-thinking class（thinkingClass:false），composer 以为 Claude 空闲 → 下一条走"立即发送"分支滚走。
- 确认默认 driver：claude-session-controller.js:140 getClaudeDriver() 默认 'sdk'。WS probe 抓 SDK 事件流：turn 内 system/init→system/status→stream_event×N→assistant→result/success，result 只在 turn 末尾一次（后端 busy/queue 正常）。
- 根因（file:line）：public/js/claude-block-renderer.js — _setThinking(true) 只在 sendInputWithEcho()（line 702，本地 echo）触发；**没有任何服务器事件把 thinking 置 true**（grep 全文仅 702 处 true）。凡是本客户端没本地发起的 turn（reload/重连/快 turn/多端）→ isClaudeThinking 恒 false → terminal-view.js:1028 sendInput 走立即发送分支 → 滚走、tray 不显示。
- 修法（最小对症）：_handleEvent 去重后、switch 前，对 LIVE（非 fromReplay、非 _exited）的 turn-progress 事件调 _setThinking(true)。新增 _isLiveTurnEvent()：assistant/partial_message/stream_event/rate_limit_event + system{init|status} 算 turn 进行中；result/user/其他 system 子类型(queued/info/...) 不算。result 仍→false 触发 flush。fromReplay（jsonl 历史回放）不置 true，避免恢复已完成会话误显示 busy。_setThinking 值不变即 no-op，幂等不刷事件。不碰 586db7d skipFlush。
- 验证：npm test 2>&1 | tee run-traybug.log → 62 pass 0 fail。新增回归 server/tests/claude-busy-thinking.test.js（7 例，真过 _handleEvent，用 SDK 实抓的事件形状，断言 nanocode:claude-thinking{thinking:true} 派发 + result→false + fromReplay 不置忙 + 幂等）。
- 3001 实测：安全重启（3002 standby 200→kill 3001 pid→relaunch 3001 200→停 3002，全程至少一端口活）。Playwright reload-mid-turn：修后 thinkingClass:true，msg2 入队（排队中(1)）；修前 thinkingClass:false。
- 截图：before /tmp/repro-reload-before-clean.log（thinkingClass:false 证据）；after /tmp/repro-after-final.png（排队中(2) tray 可见，composer 清空不滚走）/tmp/repro-reload-after.png。
- 产出：见下方 commit SHA。
- 下一步：push 到 fork zhining/nanocode-selfresume-bugs，等主人审核推 main。

## 2026-06-07 [SDK driver 取代 CLI 成为 block 模式默认驱动]
- 任务：调查 Claude SDK driver 能否在 block 模式完全取代 CLI driver，有 gap 就修，最终改默认。
- 逐项对比结论：除权限 gap 外全部对齐（model/effort/resume+continue-fallback/工具事件/interrupt/queue-flush/init-snapshot/slash/subagent/MCP/skills 经 inherited settingSources 全支持/529 fallback）。
- 修复的 gap：SDK driver 之前读 claude_permission_mode（UI 从不写入的幽灵设置）→ 永远 bypassPermissions，忽略 auto-edits/ask。改为读 global_permission（与 CLI 同源）三档 1:1 映射：full-auto→bypassPermissions / auto-edits→acceptEdits / ask→default。保留 claude_permission_mode 旧值兜底。
- 默认 driver：getClaudeDriver() 改为默认 'sdk'，仅 claude_driver==='cli' 显式 opt-out 才走 CLI。529/出错仍 fallback CLI。
- 测试：npm test → 55 pass 0 fail（新增 5 个权限映射用例）。
- 3001 实测：health 200；WS 真发 claude turn，SDK resume-miss→CLI --continue fallback 链路通；纯 SDK turn（turn2 resume 命中）工具渲染（Bash tool_use+result）/thinking/stream_event partial/assistant text/result success 全正常。
- 产出：见下方 commit SHA。
- 下一步：等主人统一验收后推 main。

## 2026-06-07 [手机端 UI 对齐 — 三键统一圆角+touch-toolbar等宽]
- 操作: public/style.css @media(max-width:480px) — 三键(.tts-btn/.tts-replay-btn/.send-btn)统一 44x44px + border-radius:var(--radius-md)(8px)
- 操作: touch-toolbar 6键改 flex:1 等宽 + height:36px + font-size:12px + white-space:nowrap
- 操作: .chat-textarea 移动端 placeholder 防换行
- 结果: 44 pass 0 fail; 3001 curl 200; 三键 borderRadius 全8px 实测；touch-btns 等宽 59px 实测
- 截图: /storage/home/zhiningjiao/code/nanocode/before-workspace.png(before) → after-workspace-390.png(after 390) after-mobile-360.png(after 360) after-desktop-1280.png(桌面无回归)
- commit: acd53e5 pushed fork/zhining/nanocode-selfresume-bugs

## 2026-06-07 [selfresume-bugs 收尾 — 喇叭合并+ntfy通用+interrupt测试+手机UI]
- 任务2: 删 public/index.html:514 旧 #tts-btn 元素(15行)，清 tts.js ttsBtn引用3处
- 任务3: index.html:340 placeholder zhiningwork→yourname; app.js 不写死 ntfy_topic 默认值
- 任务4: 3个interrupt过时测试全修 — 判定依据a33d294+9840310:
  - claude-interrupt-route: 等"Resuming with"事件(不是"Queue cleared") + 期望≥2 result events + first.subtype='error_during_execution'
  - claude-sdk-driver: subtype 'error_during_execution' + setImmediate wait + reruns.length=1
  - interrupt.test: sendRaw('\x03') 不插client-side block，期望 interrupted.length=0
- 任务5: style.css @media(max-width:480px) .tts-btn/.tts-replay-btn/send-btn/claude-stop-btn → 44px
- 结果: 44 pass, 0 fail; /api/codex/config={"model":"gpt-5.5"}; grep zhiningwork=0; 按钮44x44px ✓
- 截图: /tmp/mobile_before.png / /tmp/mobile_after.png

## 2026-06-07 [Settings模型下拉修复 — 删过时硬编码，Claude动态填充，Codex读config.toml]
- 操作: public/index.html 删除 claude-model-select 所有过时硬编码 option（opus-4-5/sonnet-4-5/haiku-4-5/opus-4/sonnet-4），只保 Default
- 操作: public/index.html 删除 codex-model-select 所有错误硬编码（o3/o4-mini/gpt-4.1/gpt-4o），只保 Default
- 操作: public/js/app.js _applyDynamicModelOptions 删除 knownModels 硬编码列表，只保 Default + snapshot.model (current)
- 操作: terminal/routes.js 新增 GET /api/codex/config，读 ~/.codex/config.toml model字段，返回 {model: "gpt-5.5"}
- 操作: public/js/app.js 新增 fetchCodexConfig + _applyCodexModelOptions，openSettingsPanel 时动态填充 Codex 下拉
- 结果: npm test 3 fail（全为既有interrupt相关，无新增）；3001重启后curl验证端点正常

## 2026-06-07 [Settings面板打磨 A-E — i18n/精简/全局Permission/通知红点/静音]
- 操作A: 新建 public/js/i18n.js，translations={en,zh}，t(key)+setLang()+applyI18n()，data-i18n属性遍历替换；Settings顶部Language下拉，默认en，即时切换
- 操作B: index.html删CLI Provider块(131-144)、删队列开关块(191-203)、删Claude驱动块(264-276)；app.js对应handler清除；队列逻辑保持默认启用
- 操作C: 新建全局Permission三档(full-auto/auto-edits/ask)，store key=global_permission；claude-session-controller.js两处permMode改读global_permission，codex TAB_LAUNCHER按档映射flags；恢复codex-model-select UI+JS handler
- 操作D: app.js新增红点系统(_addUnread/_clearUnread/favicon canvas)，window focus/visibilitychange清除；喇叭改为mute-btn全局静音，tts.js+playNotifySound均检查nanocodeMuted；ntfy loadNtfySettings默认localhost/zhiningwork
- 操作E: terminal-view.js删"⏵"字符，改为纯文字"Send now"
- 产出: commit 7850397，npm test fail=3（均既有flaky），3001 health 200 ✓

## 2026-06-04 [打断交互收口 — CLI风格强提示block + 悬空引用清除]
- 操作1：删除 terminal-view.js:377 悬空 `_interruptingAt = null`（变量已在上一个commit删除，ReferenceError隐患）
- 操作2：claude-block-renderer.js 新增公共方法 `showInterruptBlock()`，文案 "[Request interrupted by user]"（从Claude CLI binary strings命令提取的原文）
- 操作3：`sendRaw('\x03')` 路径改用 `showInterruptBlock()`（废弃旧文案"[interrupting…]"）
- 操作4：`doInterrupt()` (Esc键/Stop按钮) 调用 `activePane.showInterruptBlock()`，打断后立即在对话流插入强提示
- 操作5：style.css 新增 `.cbr-block-interrupted` 左侧色条样式（reuses cbr-block-system）
- 操作6：新增 server/tests/interrupt.test.js，8条测试覆盖：showInterruptBlock()插入块、CLI文案正确、sendRaw('\x03')文案对齐、grep验证无悬空引用
- 测试：npm test 24/24 pass, # fail 0；grep FAIL/Error/NOT FOUND → 仅 "# fail 0"
- 重启3001：kill 52877 → PORT=3001 nohup node server/index.js（PID 113275）→ health 200 ✓
- curl验证：/js/claude-block-renderer.js grep "Request interrupted by user" ✓；terminal-view.js grep _interruptingAt → 无 ✓
- 产出：commit effc79f

## 2026-06-04 [暂时禁用 --continue 自续接 — 避免 3001 测试实例抢占用户本机Claude会话]
- 操作：修改 terminal/routes.js 第 717 行，claude launcher 强制 return plain `claude --dangerously-skip-permissions; exec bash -l`
- 原 autoResume 判断 + shell loop + `claude --continue` 代码保留为 dead code，加注释说明恢复方法
- 测试结果：npm test 16/16 pass, # fail 0；grep FAIL/Error/NOT FOUND→仅"REMOTE error"测试名，无真实错误
- 重启 3001：kill 224110 → PORT=3001 nohup node server/index.js（PID 52877）→ health 200 ✓
- 验证：curl /js/terminal-view.js grep doInterrupt=5匹配（eb07a8a修复存在）✓；/js/app.js grep --continue=0 ✓
- 产出：commit 见下

## 2026-06-04 [打断/按键bug修复 P0-1~P0-4 — Esc/Ctrl+C/Stop/touch toolbar/force升级]
- 操作：修改4个文件（terminal-view.js, claude-block-renderer.js, style.css, terminal/routes.js）
- P0-1 Esc: 加优先级逻辑 slash>suggestions>interrupt>clearInput>PTY Esc; touch toolbar escape 同一函数
- P0-2 Ctrl+C: 有字时清空输入框(CLI对齐); 空+busy调interrupt API; touch ctrl-c同逻辑; ClaudeBlockRenderer.sendRaw改为POST /api/interrupt + _addSystemBlock('[interrupting…]')
- P0-3 强打断: Stop按钮click→doInterrupt()共享函数; 3s内再按escalate force=1; 显示"中断中…(再按强杀)"; 后端interrupt路由支持?force=1→SIGKILL; updateThinkingState收result事件时重置状态
- P0-4 touch toolbar: @media(pointer:coarse){.touch-toolbar{display:flex}} 补充
- 测试结果：npm test 16/16 pass, # fail 0；grep FAIL/Error/NOT FOUND→仅"# fail 0"
- 热更新: PORT=3001 health 200 ✓; /js/terminal-view.js grep doInterrupt=19匹配 ✓
- 产出: commit eb07a8a

## 2026-06-03 [Tool Blocks fold 3-level switching — 真实 3001 页面深度验证]
- 操作：用真实 Playwright browser 驱动真实 3001 页面，验证 full/header/line 三档折叠在各场景下的计算样式
- 发现：代码已正确（commit 88ce0f8 live-apply fix 已生效），前几轮 agent 只断言 localStorage，未验证 computed style / 真实 DOM 视觉变化
- 验证场景：初始加载 / 硬刷新 + WS 历史回放 / Settings 打开后切换 / Save 按钮路径 / radio click 路径
- 测试结果：npm test 6/6 PASS；孤立 harness PASS=36 FAIL=0；真实 3001 页 3 项 PASS
- 产出：evidence.md（计算样式证据 + 截图 evidence-fold-*-final.png）

## 2026-06-03 [Stop 不要杀 subagent — 传播路径实测 + 进程组隔离]
- 操作：trace Stop 传播路径（terminal-view.js → /interrupt → routes.js `cs.currentProc.kill('SIGINT')`，单正 pid，非进程组/非 SIGKILL）；写 4 个 probe 复刻 spawn 实测进程树
- 实测结论：
  - nanocode 侧已最干净，单 pid SIGINT 不会从 OS 层扫 subagent
  - subagent 是否存活取决于它在 claude 内部是否分离启动：setsid/nohup&/run_in_background → 存活（probe1/3/4）；前台未分离的 Bash 工具子进程被 claude 自身 abort 杀掉（probe2，非 nanocode 信号）；in-process Task subagent 推理随父 turn 中断结束 = harness 固有行为，nanocode 改不了
- 改动：routes.js runClaudeTurn spawn 加 `detached: true`（进程组隔离，防御性，不加 unref），interrupt 注释改写为实测结论 + 不变量
- 结果：✓ node --check 双文件 OK；npm test 6/6；terminal 测试 30 pass/6 skip/0 fail；probe4 验证 detached 下中断仍正常、分离子进程存活
- 产出：evidence.md + .interrupt-probe/probe-run-{1..4}.log；待提交
- 下一步：push fork

## 2026-06-03 [即时预览: tool-fold radio + subagent 开关 change 即时生效]
- 操作：public/js/app.js 给 input[name="tool-fold"] 三个 radio 加 change 监听 → setToolFoldLevel(value) 立刻调用；给 subagent-prompt-visible / subagent-activity-visible checkbox 加 change 监听 → setSubagentPromptVisible/setSubagentActivityVisible 立刻调用；Save 按钮保留为可选确认
- 结果：✓ npm test 6/6，playwright 验证 4 项切换均不点 Save 即写 localStorage；刷新后保持
- 产出：commit 88ce0f8，push fork zhining/nanocode-selfresume-bugs
- 下一步：等验收官确认

## 2026-06-03 [Bug修复: busy队列 + thinking解锁 + subagent fold]

**背景：主人实际使用发现3个问题，上一轮单测全过但实地用挂了。这次先复现再修再实跑验证。**

### 问题3（最重要）: busy时丢消息 → 改FIFO队列
- **根因**：`runClaudeTurn` busy时直接广播stderr "Previous turn still running, please wait." 并return，消息彻底丢弃
- **修法**：busy时push到`cs.queue`，广播`{type:'system',subtype:'queued'}`给客户端；exit handler里`setImmediate`跑下一条；interrupt时清空queue
- **验证**：`node qa-test/test-queue-and-thinking.mjs` → PASS（2个result事件、1个queued事件、0个drop消息）

### 问题2: thinking时发不了消息、要刷新才能发
- **根因**：`terminal-view.js:490` `if (isClaudeTab && isClaudeThinking) return` 硬挡。server busy拒绝→不回result→thinking卡死true→只能刷新
- **修法**：删除这个guard。有了server队列，发消息直接入队；result到了_setThinking(false)自愈。renderer加queued/info system subtype显示
- **验证**：集成测试同上，客户端不再被block

### 问题1: 开了subagent prompt开关仍看不到内容
- **抓包验证**：`claude --print --output-format=stream-json -- "用Agent工具..."` 抓包确认：
  - ✓ 顶层流确实有 `type:'assistant'` + `content[{type:'tool_use',name:'Agent',input:{prompt,description}}]`
  - ✓ `parent_tool_use_id: null`，所以`_handleAssistant`的guard不会拦
  - ✓ `_renderToolUsePart`的`isSubagentTool`匹配`name==='Agent'`正确
- **真因**：`applyToolFold(article)` 被调用在subagent-prompt blocks上。如果用户把cbr_tool_fold设为`header`或`line`，block的body就被CSS fold掉了（`display:none`）。block文章存在但内容不可见 → 用户以为开关没用
- **修法**：subagent-prompt blocks跳过`applyToolFold`，直接`setAttribute('data-fold','full')`；`setSubagentPromptVisible`里也补set

### 产出
- 3个原子提交：e1a7fda（队列）、6d561bd（thinking）、f067851（subagent fold）
- 集成测试：`qa-test/test-queue-and-thinking.mjs` ALL PASS
- run.log: grep -i "FAIL|Error|MISMATCH" → 干净

## 2026-06-03 [Task B 补丁: subagent assistant/partial_message gate 漏洞]
实地抓取验证（claude --print --output-format=stream-json --verbose --include-partial-messages）：
  - 当前 claude CLI 版本（Opus 4.8）中，assistant 和 partial_message 事件的 parent_tool_use_id 永远是 None
  - subagent 活动只通过 user 事件（pid 非空）暴露在顶层流
  - 但防御性编码必要：若未来版本产生带 pid 的 assistant/partial 事件，或通过 mock 构造测试，原代码漏洞会导致开关关闭时 subagent 活动仍渲染并污染 _liveAssistantBlock 状态
修法（/public/js/claude-block-renderer.js）：
  - `_handleAssistant`：顶部加 `if (event.parent_tool_use_id && !getSubagentActivityVisible()) return`（在 live-block 清零之前 return，避免状态污染）
  - `_handlePartialMessage`：同上，在 msg 解析之前 return
  - 主 agent 事件（pid=null/undefined）完全不受影响
验证：
  - 7 个 mock 行为验证 case 全 pass（含：主 agent toggle off → RENDERED；subagent toggle off → SKIPPED；subagent toggle on → RENDERED）
  - node --check 语法 OK
  - npm test 6/6 pass，grep FAIL/Error run.log → "# fail 0"
commit 7e9c0d6

## 2026-06-03 [Task A + B: tool折叠修复 + subagent可见性开关]

### Task A - Tool Blocks 折叠设置无效（根因确认）
根因1：CSS `.cbr-block-tool[data-fold="full"]` 规则要求属性**显式设为"full"**才显示内容。无属性时无 display:block 兜底规则。但 `applyToolFold(article)` 在渲染时读 localStorage，正常情况下会设置属性，所以这不是主因。
根因2（主因）：`_handleUserEvent` 只提取 `content.find(c => c.type === 'text')` 的文本内容，完全忽略了 `tool_result` 类型的 item。工具输出（Bash stdout、文件内容等）以 `tool_result` 形式出现在 user-turn 事件里，之前从未被渲染——这才是「看不到具体内容」「全是一条线」的根本原因。
修法：
  - CSS 加 `:not([data-fold])` 兜底规则
  - `_handleUserEvent` 改为遍历所有 content 项，遇到 tool_result 调用 `_renderToolResultPart`
证据：
  - 实地抓取 stream-json 确认：`user` event 中 `content[].type === "tool_result"`, `content[].content` = 输出字符串
  - npm test 6/6 pass，grep -i "FAIL|Error" run.log → "# fail 0"
  - commit 9ca1b73

### Task B - Subagent 可见性开关
实地抓取确认真实事件字段：
  - Subagent 调用：`assistant` event，`tool_use.name === "Agent"`，`input = {description, prompt, subagent_type}`
  - Subagent 活动：`user` event，`parent_tool_use_id` 设为 Agent tool 的 id（非 null）
两个开关（Settings > Subagent Visibility，localStorage 持久化，即时生效）：
  - 「Show message sent to subagent」默认开：控制 Agent/Task tool_use 块中 input.prompt 的显隐
  - 「Show subagent activity」默认关：控制 parent_tool_use_id 非空的 user 事件显隐
codex 处理：Bash tool_use 命令含 "codex" 正则匹配为启发式 codex dispatch，加 cbr-block-subagent-prompt 类，受开关1控制。注释已说明判定方式。
commit 03beb00

## 2026-06-03 10:30 [Bug2补丁：原地重连重复渲染]
- 根因：ClaudeBlockRenderer 原地重连（onclose → setTimeout → _connect()）时，同一 renderer 实例的 _scroll DOM 没被清空，server 重放 cs.history 后 = 旧渲染 + 重放 = 双份内容。Bug2 把 user 事件也加进了 history，让这个重复更明显。
- 修法：在 _ws.onopen 里，先判断 isReconnect（reconnectAttempts > 0，因为首次连接时该值为 0），若是重连则清空 _scroll.innerHTML + 重置 _liveAssistantBlock / _liveAssistantId / _pendingNonces / _thinking，并插一条 "[Reconnected. Restoring session history…]" 系统块作为视觉分隔。首次连接不受影响（_scroll 本来为空）。
- 验证：5 个内联 Node.js 单元测试（模拟 onopen 逻辑 + _handleUserEvent 逻辑）全部 pass；npm test 6/6；node --check 语法 OK；grep FAIL/Error run.log → "# fail 0"
- 产出：commit 60a731a

## 2026-06-03 09:55 [Bug1-5 + 自续接功能]
- 操作：实现 5 项 bug fix + 自续接功能
  - Bug1 (IME回车): terminal-view.js 加 compositionstart/compositionend 标志位 + e.isComposing + keyCode 229 守卫，阻止输入法合成期间 Enter 触发发送
  - Bug2 (消息不可见): routes.js 在收到 claude-input 时存 synthetic user event 到 cs.history；client 端 sendInputWithEcho 带 nonce，_handleUserEvent 通过 nonce dedup 避免双渲染，reconnect 回放时无 nonce 则正常渲染
  - Bug3 (滚到底按钮): claude-block-renderer.js 在 container 内创建 .cbr-scroll-to-bottom 浮动按钮，scroll 事件更新可见性；style.css 加 transition + absolute positioning
  - Bug4 (tool折叠): claude-block-renderer.js 新增 getToolFoldLevel/setToolFoldLevel/applyToolFold 模块函数，_renderToolUsePart 加折叠按钮+点击 header 切换单块；style.css data-fold="full|header|line" CSS 属性控制；index.html + app.js 加 Settings UI
  - 自续接: routes.js TAB_LAUNCHERS.claude 改为 shell 循环（读 store.getSetting('claude_autoresume')），支持 3 秒倒计时 + 任意键退出到 bash；Settings UI 切换开关存 localStorage + server
- 产出：commits 06c41e7, 000687f, 1cf2bd1, 78d7d4b
- 测试：npm test 6/6 pass, grep -i FAIL/Error run.log → "# fail 0"，PORT=3099 server 启动 200 ✓
- 下一步：等主人 QA 验收

## 2026-03-19 23:55 [Agent 命名功能]
- 操作：实现 session 自定义命名功能
  - store.js: 新增 sessionNames 数据层 (get/set/getAll)
  - routes.js: 新增 GET /session-names 和 PUT /sessions/:id/name API
  - api.js: 新增 fetchSessionNames / updateSessionName 前端 API
  - terminal-view.js: session tab 显示自定义名称，双击重命名
  - style.css: 新增 .session-rename-input 样式
  - store.test.js: 新增 2 个测试用例
- 结果：✓ 全部 10 个测试通过
- 产出：commit d84bf8a on zhining/agent-naming-and-ux
- 下一步：继续下一个 TODO 任务

## 2026-03-20 00:05 [Claude 界面自动滚动到最新]
- 操作：terminal-pane.js 新增滚动跟踪 + 浮动「滚到底部」按钮
- 结果：✓ 通过
- 产出：commit dfda767

## 2026-03-20 00:20 [文本复制功能]
- 操作：Ctrl+C 选中时复制、无选中时发送 ^C；移动端添加 Copy 按钮
- 结果：✓ 通过
- 产出：commit be31415
- push 到 zhining/agent-naming-and-ux

## 2026-03-20 00:30 [手机端滑动体验优化]
- 操作：重写 touch scroll 为带惯性的平滑滚动（velocity tracking + friction decay）
- 结果：✓ 通过
- 产出：commit 8f714ae

## 2026-03-20 00:40 [全面探索并完善产品体验]
- 操作：通读全部代码，修复 XSS 漏洞（landing.js innerHTML 注入），清理废弃代码
- 结果：✓ 通过，4 条改进建议写入 proposals.md
- 产出：commit 8856d89
- push 到 zhining/agent-naming-and-ux，可酌情 PR

## 2026-03-20 01:30 [验收官反馈修复]
- 操作：修复验收官提出的 4 个问题
  - CSS 变量修复：landing-new-form 的 --bg-2/--border/--fg-1 等替换为 glass design system 变量
  - --fg-3 对比度提升：0.4 → 0.55 (WCAG AA 合规)
  - WebSocket 连接状态三态：disconnected → connecting(黄色脉冲) → connected(绿色)
  - Claude 模式图标：锁🔒改为星★，语义更匹配 AI 助手
  - 新增 3 条改进建议写入 proposals.md（session 内存泄漏、原子写入、history.jsonl 优化）
- 结果：✓ 全部 10 个测试通过
- 产出：commit c999db5
- push 到 zhining/agent-naming-and-ux
- 旧 3001 进程已停止，新代码在 PORT=3001 重启完毕

## 2026-03-20 10:15 [自动滚动 bug 修复]
- 操作：修复用户反馈的"agent 说话时页面跳到最上边"的 bug
  - 根因：term.onScroll 在 term.write() 期间同步触发，在 scrollToBottom() 执行前就将 _userScrolledUp 设为 true，导致自动滚动被跳过
  - 修复：移除 term.onScroll handler，仅保留 DOM viewport scroll listener（在 scroll position 实际变化后触发）
  - 额外：用 requestAnimationFrame 包裹 viewport listener 挂载，确保 xterm 渲染完成
- 结果：✓ 全部 10 个测试通过
- 产出：commit ca65f96
- push 到 zhining/agent-naming-and-ux，3001 已重启新代码

## 2026-03-20 10:45 [7 项功能批次实现]
- 操作：一次性实现 proposals.md 中 7 项功能
  1. Favicon + PWA manifest：SVG favicon (>_) + manifest.json
  2. WebSocket 心跳超时：per-client ping 追踪，30s 无 ping 断开
  3. Project 搜索：sidebar 4+ 项目时显示搜索框，按名称/SSH host 过滤
  4. 终端字体大小：Settings 页 range slider (10-22px)，实时应用到终端
  5. Session GC：PTY 退出 + 无 client 30 分钟后自动清理
  6. 原子写入：store.js save() 先写 .tmp 再 rename
  7. 空 sidebar 引导："No projects yet. Click + to add one."
- 结果：✓ 全部 10 个测试通过
- 产出：commit 6310ab4
- push 到 zhining/agent-naming-and-ux，3001 已重启新代码


## 2026-03-21 [TTS 按钮不可见修复]
- 操作：修复 TTS 按钮在 mac 和安卓都看不到的问题
  - 根因：CSS 变量 --surface-2/--surface-3 未在 :root 定义，tts-btn 和 mic-btn 背景透明
  - 根因：SVG fill="none" + 非激活时 wave 隐藏，只剩极细描边 polygon 几乎不可见
  - 修复：:root 添加 --surface-2: rgba(255,255,255,0.08) 和 --surface-3: rgba(255,255,255,0.12)
  - 修复：speaker polygon 添加 fill="currentColor"
- 结果：✓ 10/10 测试通过，热更新部署 3001 正常
- 产出：commit 62c248c
- 下一步：用户确认移动端和桌面端可见

## 2026-03-21 [TTS 听不到声音修复]
- 操作：修复 TTS 音频无法播放问题
  - AudioContext unlock：首次用户交互时创建静音 buffer 解锁浏览器 autoplay 策略
  - Settings 新增 "Test TTS" 按钮：用户手动触发测试语音播放
  - play() 错误日志：不再静默吞掉，console.warn('[TTS]') 方便调试
- 结果：✓ 10/10 测试通过，热更新部署 3001 正常
- 产出：commit 待提交

## 2026-03-21 [TTS 偶尔蹦日语修复]
- 操作：server/index.js getTtsConfig() text_lang 默认从 'auto' 改为 'en'；顺带修复 handleTts 末尾多余 `})` 语法错误
- 结果：✓ TTS 200 OK，热更新部署 3001 成功
- 产出：commit d45681b
- 下一步：等验收官确认

## 2026-03-22 [重播按钮修复]
- 操作：删除 Test TTS 中 setLastTtsText(testText)；replay 按钮 tooltip 改为 "Replay last message"
- 结果：✓ 热更新 3001 成功，两项 curl 验证通过
- 产出：commit 9137eca
- 下一步：等验收官确认

## 2026-03-22 [TTS 音色优化 NanamiNeural]
- 操作：edge-tts ja-JP-NanamiNeural 生成参考音频 → ffmpeg 转 WAV → 替换 GPT-SoVITS ref_audio → /api/tts/voice 持久化
- 结果：✓ POST /api/tts → 200, 29KB OGG Vorbis，新甜美猫娘声工作正常
- 产出：/storage/home/zhiningjiao/code/GPT-SoVITS/ref_audio.wav（已替换），旧版备份为 ref_audio_backup_xiaoy.wav
- 下一步：等主人和验收官试听确认音色效果

## 2026-03-22 [重播按钮读所有历史修复]
- 操作：replay handler 加 stopTts() 先清空队列，再 push ttsLastText
- 结果：✓ stopTts() 出现 3 次，3001 已服务最新静态文件
- 产出：commit 524447c
- 下一步：等验收官确认

## 2026-03-22 [TTS 重复播报修复]
- 操作：sessions.js 始终发 history 消息 + stripAnsi 补全 + enqueueTts 队列内去重
- 结果：✓ 3001 热更新成功，served JS 验证 2 项通过
- 产出：commit 784e8fd
- 下一步：等验收官确认

## 2026-03-22 [QA 信号监听服务]
- 操作：server/qa-watcher.js（fs.watch）+ /ws/notify WS endpoint + 前端 toast
- 结果：✓ 测试写入 qa-signal.json → 服务端检测到 → tmux notified reviewer: nanocode QA watcher test
- 产出：commit 63632f7
- 下一步：等验收官确认

## 2026-03-22 [done 信号 + activity-feed]
- 操作：qa-watcher.js 扩展 done-signal 监听 + evidence.md 聚合；app.js 扩展 done_notify/activity WS 处理
- 结果：✓ done-signal 检测、agent-status 追加、evidence 聚合均验证通过
- 产出：commit afa2d6b
- 下一步：等验收官确认

## 2026-03-22 [fs.watchFile CephFS 修复]
- 操作：qa-watcher.js fs.watch → fs.watchFile 2s 轮询，覆盖 qa/done/evidence 6个文件
- 结果：✓ QA signal 轮询触发验证通过
- 产出：commit b613ff7
- 下一步：等验收官确认

## 2026-03-23 [watchFile persistent:true 修复]
- 操作：persistent: false → true，防止 Node 事件循环退出导致 callback 不触发
- 结果：✓ echo qa-signal → sleep 5s → [watcher] QA signal: nanocode persistent:true test
- 产出：commit aefcd8d

## 2026-06-07 [手机端 UI 对齐修复]
- 任务：修复 5 个手机端 UI 问题（按钮高度/黑条/标签间距/工具块对齐/整体正负形）
- 操作：只改 public/style.css，不碰后端/block-renderer.js
- 结果：
  - 问题1: tts/replay/send 按钮 height 44→38px，与 textarea 一致，垂直居中
  - 问题2: .claude-queue-tray:empty {display:none} 消除无意义黑条
  - 问题3: mobile-pane-switch gap 4→8px, padding 8px 12px→6px 8px，左右边缘均衡
  - 问题4: cbr-tool-header 加 gap:8px；icon-wrap 固定 16px；name line-height:1；subagent-badge 移除 margin-left
  - 问题5: 整体间距遵循 8px 网格，desktop 无回归
- 测试：npm test 55/55 pass，3001 200 OK
- 产出：commit bc197e3, 8431296；push fork zhining/nanocode-selfresume-bugs
- 截图：/tmp/before_workspace_390.png, /tmp/after_workspace_390.png, /tmp/final_mobile_390.png, /tmp/final_desktop.png

## 2026-06-07 [Favicon 红点角标修复]
- 任务：修复 _drawFaviconDot() 把 favicon 换成纯绿方块的 bug，改为原 logo + 右上角小红点角标
- 根因：原实现用 fillRect(#8cc63f) 画了绿方块当底，没有 drawImage 原 SVG
- 操作：public/js/app.js - 新增 _preloadFaviconImage()，在 init() 里调用；_drawFaviconDot() 改为 drawImage(原SVG) + 右上角 r=6 红圆点+数字
- 原 favicon：SVG（黑底圆角矩形 + 绿色 >_ 文字），`/favicon.svg`
- 验证：browse 渲染测试截图 /tmp/favicon-badge-test.png，左=logo+badge(3) 右=原始logo，SVG drawImage 成功
- 测试：npm test 71/71 pass，run-favicon.log 干净，curl 3001/api/health 200
- 截图：/tmp/favicon-badge-test.png
