[QA] 打断交互收口——CLI风格强提示block + 悬空引用清除
根因：terminal-view.js:377 _interruptingAt = null 悬空 ReferenceError（变量已删）；Esc/Stop打断无任何对话流提示；sendRaw('\x03') 仍用旧文案"[interrupting…]"
修法：
  1. 删 terminal-view.js:377 悬空引用
  2. claude-block-renderer.js 新增 showInterruptBlock()，文案 "[Request interrupted by user]"（Claude CLI binary 原文）
  3. sendRaw('\x03') 改调 showInterruptBlock()，终结旧文案
  4. doInterrupt() (Esc/Stop btn) 调 activePane.showInterruptBlock()
  5. style.css 加 .cbr-block-interrupted 左侧色条样式
  6. 新增 server/tests/interrupt.test.js 8条测试（DOM stub + grep双验证）
run.log: npm test 24/24 pass, fail 0 ✓ 热更新: PORT=3001 health 200 ✓ commit: effc79f

[QA] 暂时禁用 --continue 自续接（避免抢占用户本机Claude会话）
terminal/routes.js:717 强制 return plain claude，dead code 保留注释，恢复只需删3行
run.log: 16/16 pass, fail 0 ✓ 热更新: health 200 ✓ doInterrupt ✓ --continue=0 ✓

[QA] 打断/按键bug修复 + claude tab交互对齐CLI (P0-1~P0-4)
根因1: terminal-view.js Esc 分支只关 UI 不打断；Ctrl+C 有字时被吞；touch toolbar escape/ctrl-c 只操作前端
根因2: ClaudeBlockRenderer.sendRaw '\x03' 只显示提示，不调 interrupt API
根因3: Stop 按钮按下后立即切回就绪，无 interrupting 视觉状态，force 升级缺失
根因4: touch-toolbar 只在 max-width:768px 显示，横屏手机/平板看不到
修法: Esc优先级队列(slash>suggestions>interrupt>clearInput>PTY Esc); Ctrl+C有字清空/空时打断; ClaudeBlockRenderer.sendRaw 改POST interrupt API; Stop按钮显示"中断中…(再按强杀)"状态; 后端interrupt路由支持force=1 SIGKILL; CSS补@media(pointer:coarse).touch-toolbar{display:flex}
run.log: npm test 16/16 pass, fail 0 ✓ 热更新: PORT=3001 health 200 ✓ commit: eb07a8a

[QA] session already in use bug — 发消息第一次报错第二次才成
根因1: bash -lc 'claude ...' → SIGINT 只到 bash → claude orphan → session 锁冲突
根因2: session lock 释放有时间差 → exit 后立即 spawn 仍冲突
修法: launchCmd 加 exec 前缀 + stderr 检测 already-in-use → 1s 后自动重试（最多2次）
run.log: 16/16 pass, fail 0 ✓ 热更新: health 200 ✓ commit: a25feff

[QA] **P0 queue=CLI 同款体验**（主人 2026-06-04 实测+澄清，3001 端口）
根因：Stop → updateThinkingState(false) 立即 flush → cs.busy=true 时消息入 cs.queue → Claude 退出 wasInterrupted=true → cs.queue 丢弃 → 消息丢失
修法：Stop handler 不调 updateThinkingState，仅更新视觉；等真实 result WS 事件到（cs.busy=false）→ updateThinkingState(false) → flush → runClaudeTurn 直接执行
三 bug 全修：A.消息不丢 B.托盘清空 C.CBR 用户块可见
run.log: npm test 16/16 pass, fail 0，grep FAIL/Error → "# fail 0"
热更新: PORT=3001 health 200 ✓ commit: b67a2b6

[QA] Bug1: 回车发送 — 中文输入法合成态也会触发发送 (terminal-view.js:520)
commit: 06c41e7 — 加 compositionstart/compositionend + isComposing + keyCode 229 守卫
[QA] Bug2: 用户消息不可见 — WS重连/回放后看不到自己发的消息 (claude-block-renderer.js + routes.js)
commit: 000687f — server 把 user turn 存 history + client nonce dedup 避免重复渲染
[QA] Bug3: 滚到底按钮消失 — 新增浮动「滚到最底」按钮
commit: 000687f — cbr-scroll-to-bottom button + CSS in 1cf2bd1
[QA] Bug4: tool折叠显示修复 — 工具输出可见 + 折叠三档正常工作 + subagent 开关
根因：tool_result 从未渲染（_handleUserEvent 只处理 text 类型）+ CSS 无兜底规则
commit: 9ca1b73 (Task A fold fix) + 03beb00 (Task B subagent toggles)
[QA] 自续接功能 — claude 退出后自动 --continue 重开 + 3秒倒计时 + 设置开关
commit: 000687f — TAB_LAUNCHERS.claude shell loop + Settings toggle

[QA] 右侧 Agent 管理工具栏 — 统一管理所有 agent
run.log: npm test 16/16 pass, fail 0 (grep FAIL/Error → "# fail 0")
APIs: GET /api/agents ✓ GET /api/agents/discover (tmux 扫描+类型识别) ✓ PUT /api/agents (持久化) ✓
UI: agents.js initAgentDrawer() — 抽屉开关/增删改/discover/最近会话 resume ✓
热更新: PORT=3001 health 200 ✓ commit: eea3f17

[QA] Settings 端口监控增强 — 显示本机地址 + 可增减监控 IP/端口
run.log: npm test 16/16 pass, fail 0 (grep FAIL/Error → "# fail 0")
APIs: GET /api/services-config → services 5条 + localIPs 5个 ✓ PUT /api/services-config ✓ GET /api/services (健康状态) ✓
UI: loadServices() 显示本机IP + _renderServicesGrid() 增删改 + svc-add-form 添加 ✓
热更新: PORT=3001 health 200 ✓ commit: eea3f17

[done] Claude Code 界面闪屏 — agent 输出新行时屏幕会闪
主人反馈：Claude Code 终端窗口在 agent 输出新行时会闪屏。
可能原因：xterm.js write 触发了某种全屏重绘、autoResize、或 scrollToBottom 导致闪烁。
排查 terminal-pane.js 的 onData/write 回调，看是否有不必要的 DOM 操作或 viewport 重置。

[done] 浏览器通知音效 — 文件监控事件（done/blocked/QA）播放提示音
qa-watcher 已经通过 WebSocket 广播 done_notify、qa_notify、blocked_notify 事件。
需要前端收到这些事件时播放提示音 + 显示 toast。

要求：
1. 默认音效：竹子碰撞声（清脆短促，找一个免费的 bamboo knock sound effect）
2. 不同事件可以用不同音效（done=竹子碰撞，blocked=低沉提示，QA=轻快叮咚）
3. Settings 页加"通知音效"区域：
   - 总开关（开/关）
   - 各事件类型的音效选择（下拉或上传自定义音频文件）
   - 音量滑条
   - 试听按钮
4. 音效文件放 public/audio/ 目录，默认内置 2-3 个
5. 移动端也要能播放（注意 AudioContext 解锁）

app.js 里已经有 notify WebSocket 监听，在现有 toast 显示的地方加音效播放即可。

[done] Agent 命名功能 — 当前 agent 名称不明确，用户无法自定义命名
[done] 手机端滑动体验优化 — 移动端网页滑动不顺畅
[done] Claude 界面自动滚动到最新 — 查看 Claude 输出时会跑到顶部
[done] 文本复制功能 — 终端内无法复制文本
[done] 全面探索并完善产品体验
[done] 自动滚动 bug — agent 说话时页面会跳到最上边（commit ca65f96 修复）

[done] favicon + PWA manifest — 添加 SVG favicon 和 manifest.json 支持 PWA
[done] WebSocket 心跳超时断开 — 服务端追踪 ping/pong 超时断开 stale 连接
[done] project 排序/搜索 — sidebar 添加搜索框方便多项目查找
[done] 终端字体大小设置 — Settings 页添加字体大小控制
[done] 退出 session 内存泄漏 GC — PTY 退出后定时清理 stale Session
[done] store.js 原子写入 — 先写临时文件再 rename 防数据损坏
[done] 空 sidebar 引导文案 — 无 project 时显示引导提示

[done] 手机滑动不顺滑 — 移动端 xterm 改 pan-y + 收窄 iOS killScroll（避免与内部滚动争抢）

[done] Ask Claude 输入框发送方式修改 — 单次 Enter 换行，Ctrl+Enter/双击 Enter 发送（commit f59f0c4）
[done] Claude 界面跳到顶部修复 — programmatic scroll guard + write callback scrollToBottom（commit f59f0c4）

[done] 语音输入功能 — Web Speech API 麦克风按钮，支持手机和桌面

[done] Ask Claude 输入框按回车后终端文本跳到顶部 — autoResize 期间保存/恢复 viewport scrollTop + programmaticScroll guard

[done] 集成 GPT-SoVITS 语音合成 — nanocode 端 TTS 集成完成（后端代理 + 前端播放）
待 GPT-SoVITS 服务部署后即可使用。音色配置等后续按需扩展。


[done] 部署 GPT-SoVITS 本地 TTS 服务
- GPT-SoVITS v2 deployed at ~/code/GPT-SoVITS, venv, CUDA GPU 1
- API running at http://127.0.0.1:9880, pretrained models downloaded
- Reference audio: edge-tts XiaoyiNeural → ref_audio.wav
- nanocode proxy verified: POST /api/tts → 200 OK, 166KB WAV, 2.6s audio
- 前端 TTS status 显示 available: true


[done] TTS 按钮在网页上找不到 — mac 和安卓都没有
根因：--surface-2/--surface-3 CSS 变量未定义（背景透明）+ SVG fill="none"（图标仅细线描边）
修复：添加 CSS 变量定义 + speaker polygon fill="currentColor"


[done] TTS 听不到声音 — 按钮可能太小看不到 + 浏览器 autoplay 问题
修复：AudioContext unlock（iOS/Chrome autoplay 策略）、Settings 中 Test TTS 按钮、play() 错误日志


[done] Settings 页面不能往下滑 — 内容被截断
根因：.tab-content 有 overflow:hidden，.settings-container 没有自己的滚动
修复：.settings-container 添加 overflow-y:auto + flex:1 + min-height:0


[done] TTS 安卓 Chrome 听不到声音 — 换 OGG 格式 + 调试
修复：默认 media_type 从 wav 改为 ogg，Content-Type 动态匹配，前端全链路 console.log 调试


[done] TTS 间歇性 502 — 主人反馈仍有 502 但后端测试正常
根因：GPT-SoVITS 缺 NLTK averaged_perceptron_tagger_eng 资源，混合语言文本触发 400/500
修复：下载 NLTK 资源 + proxy 60s 超时 + 自动重试 1 次 + 前端 toast 提示


[done] Playwright 前端验证移交给验收官负责


[done] TTS 播报内容过滤 — 不要播报时间戳和命令输出，只播报自然语言
修复：onClaudeOutput 只提取 [TTS_START]...[TTS_END] 标记内内容；terminal-pane 显示时自动去掉标记


[done] TTS 复读机 bug — 同一句话重复朗读 + 加重播按钮
修复：hash dedup 防重复播报 + 重播按钮（回旋箭头图标，TTS 按钮旁，播报后显示）


[done] 重播按钮看不到 — 放在 TTS 开关按钮旁边
修复：按钮始终可见（36px，与 TTS 按钮同尺寸），无内容时 opacity 0.3 灰显


[done] 重播按钮灰色不能按 — 应该在有 TTS 内容后立即可用
修复：提取 setLastTtsText() 统一管理，Test TTS 按钮也会激活重播按钮


[done] GPT-SoVITS 服务守护 — 反复挂掉需要自动重启
修复：~/code/start-tts.sh watchdog 脚本（15s 检测 + 自动拉起），tmux session tts-watchdog 运行
前端 TTS 失败时显示 "Voice service restarting, please wait..."


[done] 添加 TTS 调试 log 面板 — 主人想知道为什么有时有声音有时没有
修复：Settings TTS 区域添加可折叠 Debug Log 面板，记录全链路状态（颜色区分 ok/warn/err/skip），同步输出 console


[done] TTS 重播按钮和正常语音播报没有 log — 只有测试语音有
修复：enqueueTts 添加 Enqueued/Skipped log，replay 按钮添加 Replay log，空内容时 warn 提示


[done] TTS 503 并发问题 + 重播内容拼接错误
修复：后端 serial queue 防并发；前端每段 TTS 单独 enqueue，lastTtsText 只存最后一段


[done] 刷新页面后 TTS 从头到尾播报整个终端历史 — 只应读最新一条
修复：_historyDone flag 在 history 消息后才允许 onOutput 回调，2s 超时兜底新会话


## [done] TTS 偶尔蹦日语 — 改为固定英语输出
主人反馈 TTS 偶尔会蹦出日语。当前 text_lang 设的是 auto 自动检测，有时误判。
修复：
1. TTS API 请求的 text_lang 从 "auto" 改为 "en"（固定英语）
2. 或者如果主人主要用中文，改为 "zh"
3. ref_audio 的 prompt_lang 也要对应
4. 热更新部署


## [done] TTS 开关旁边的按钮应该是重播最近一条 — 不是测试 TTS
主人反馈：TTS 开关按钮旁边那个按钮（重播按钮）点击后应该是重播最近一条 TTS 消息，不是测试语音。
检查：
1. 重播按钮的 click handler 是否调用 playTtsNonStreaming(lastTtsText)
2. lastTtsText 是否正确保存了最近一条 [TTS_START]...[TTS_END] 的内容
3. 如果 lastTtsText 为空，按钮应该灰显不可点击
4. 按钮 tooltip 改为 "Replay last message"
修完热更新部署。


## [done] 执行 proposals.md 中 TTS 音色优化方案 — NEKOPARA 猫娘声
参考 proposals.md 中验收官调研的"TTS 音色优化"方案：
1. 搜索 HuggingFace 上的 NEKOPARA/猫娘/日系少女音色模型
2. 下载适合的参考音频（甜美少女声）
3. 替换 GPT-SoVITS 的 ref_audio.wav 和 prompt_text
4. 测试新音色效果
5. 如果效果不好，用 edge-tts 生成更好的参考音频


## [done] 重播按钮只重播最近一条 — 当前从下往上读所有历史
验收通过 2026-03-22 20:xx PASS ✓
凭证：curl http://10.18.8.55:3001/js/terminal-view.js | grep -n "stopTts\|ttsLastText" 确认：
- line 1301: stopTts()（清空 ttsQueue，停止播放）
- line 1302: ttsQueue.push(ttsLastText)（只推最后一条）
grep -i "FAIL|Error|NaN" evidence.md → 0 matches
HTTP 200 ✓


## [done] TTS 语音播报说两次 — 同一段内容重复播放
验收通过 2026-03-22 21:30 PASS ✓
凭证：grep -i "FAIL|NaN|Error" evidence.md → 0 failures；HTTP 200 ✓
- ✓ sessions.js line 129: always sends history message (even empty) → _historyDone=true immediately
- ✓ terminal-view.js line 1162: OSC sequences stripped in stripAnsi
- ✓ terminal-view.js line 1229: ttsQueue.some() in-queue dedup check
commit: 784e8fd


## [done] QA 信号监听服务 — fs.watch 实时通知验收官
验收通过 2026-03-22 21:35 PASS ✓
凭证：grep -i "FAIL|Error" evidence.md → 0 failures；HTTP 200 ✓
- ✓ server/qa-watcher.js 存在：fs.watch + tmux send-keys + WS broadcast
- ✓ server/index.js line 8: import；line 239: startQaWatcher(broadcastNotify)
- ✓ ~/code/qa-signal.json 存在，有真实条目（3条）
- ✓ node 进程 PID 181164 运行中


## [done] done 信号监听 — 验收官标 done 后通知猫娘秘书
验收通过 2026-03-22 21:40 PASS ✓
凭证：HTTP 200；grep -i FAIL/Error evidence → 0 failures
- ✓ qa-watcher.js handleDoneEntries: fs.watch done-signal.json → appendFileSync agent-status.md [DONE_SIGNAL] + WS broadcast
- ✓ done-signal.json 存在，有真实条目（{"repo":"nanocode","task":"QA 信号监听服务","reviewer":"PASS"}）
- ✓ activity-feed.json 2 entries 已生成

## [done] 信号文件带技术摘要 + evidence 聚合 activity-feed
验收通过 2026-03-22 21:40 PASS ✓
凭证：HTTP 200；grep -i FAIL/Error evidence → 0 failures
- ✓ qa-watcher.js handleEvidenceChange: fs.watch {repo}/evidence.md → extractLastEvidence → appendActivityFeed (max 100)
- ✓ summary 字段支持：broadcast({type:'qa_notify', summary: entry.summary||''})
- ✓ activity-feed.json 2 entries：nanocode evidence 已聚合
- ✓ 4个仓库 evidence.md 均已注册 watch

## [done] 信号监听在 CephFS 上不工作 — fs.watch 换成 fs.watchFile
验收通过 2026-03-22 22:35 PASS ✓
凭证：HTTP 200；代码审查确认
- ✓ qa-watcher.js line 8: import watchFile（不再使用 watch）
- ✓ POLL_INTERVAL_MS = 2000
- ✓ watchFile(QA_SIGNAL_PATH, {persistent:false, interval:2000}, ...)
- ✓ watchFile(DONE_SIGNAL_PATH, ...) + watchFile(evidence.md, ...) × 4仓库
- ✓ qa-signal.json 有 "watchFile test" 验证条目


## [done] watchFile persistent:false 导致 callback 不触发
验收通过 2026-03-23 PASS ✓
凭证：qa-watcher.js line 139: persistent: true ✓；HTTP 200；grep -i FAIL/Error evidence → 0
commit: aefcd8d

## [done] 热更新部署 watchFile persistent:true 修复 + 端到端测试
验收通过 2026-03-23 PASS ✓
凭证：PID 317184；done-signal 3→4 ✓；evidence→activity-feed 3→4 ✓；health 200 ✓
commit: aefcd8d


## [done] 信号监听加 blocked 触发 — blocked 也要通知猫娘秘书
当前 qa-signal.json 只在标 [QA] 时触发。但 [blocked] 也需要通知：
1. agent 标 [blocked] 时追加 ~/code/qa-signal.json：
   {"time":"...","repo":"dccpipeline","task":"BPY Phase 2","qaType":0,"status":"blocked","reason":"需要约束式重定向","summary":"..."}
2. nanocode watcher 检测到 status=blocked → tmux 通知猫娘秘书（不是验收官）
3. 猫娘秘书判断：真 blocked → 帮忙解决 / 假 blocked → 踢回去继续做

同时更新全局 CLAUDE.md：
- 标 [blocked] 时也要追加 qa-signal.json（qaType=0, status=blocked）
- blocked 必须写明具体原因和尝试过什么


## [done] TTS 触发后仍然读 terminal 历史内容 — _historyDone 机制不够
主人反馈：语音触发后还是会找 terminal 存在的以前的 TTS 标记来读。
当前 _historyDone flag 不够可靠。
修复方案：
1. 记录页面加载时 terminal 的 scrollback buffer 长度（初始字符数）
2. 只对超出初始长度的新增内容做 TTS 提取
3. 或者更简单：记录连接时间戳，只对时间戳之后的 WebSocket 消息做 TTS
4. 确保刷新页面后完全不读旧内容
修完热更新部署。


## [done] 端口健康检查服务 — 替代猫娘秘书的巡查
在 nanocode server 加端口健康检查：

### 后端
1. server 每 30 秒检查 5050/8765/8000/3001/9880 端口是否在线（net.connect 或 http.get）
2. 状态存内存，提供 API：GET /api/health → {"5050":"up","8765":"up","8000":"down",...}
3. 端口挂了 → console.warn + WebSocket 广播通知
4. 可选：端口挂了自动尝试重启（知道启动命令的话）

### 前端 Settings 页
在 Settings 加一个 "Services" 小组件：
- 5 个端口状态指示灯（绿/红）
- 端口名称（mblend:5050 / dccpipeline:8765 / regression:8000 / nanocode:3001 / TTS:9880）
- 最后检查时间
- 端口挂了红色闪烁 + 点击可看详情

### 配置
端口列表写在 server 配置里，方便以后增减：
```json
{"ports": [
  {"name": "mblend", "port": 5050, "host": "10.18.8.55"},
  {"name": "dccpipeline", "port": 8765, "host": "10.18.8.55"},
  {"name": "regression", "port": 8000, "host": "10.18.8.55"},
  {"name": "nanocode", "port": 3001, "host": "localhost"},
  {"name": "TTS", "port": 9880, "host": "localhost"}
]}
```

这样猫娘秘书巡查时不用再 ss -tlnp 检查端口了，看 /api/health 一个请求搞定。
Settings 页面主人也能直接看到各服务状态。

