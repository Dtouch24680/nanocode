[QA] selfresume-bugs 收尾：模型下拉/喇叭合并/zhingwork/interrupt测试/手机UI
任务1: 模型下拉前端已就绪，后端 /api/codex/config 返回 {"model":"gpt-5.5"} ✓ claude init-snapshot 动态填充 ✓
任务2: 删旧 #tts-btn（public/index.html:514），tts.js 清 ttsBtn 引用，mute-btn 为唯一声音键
任务3: zhiningwork → yourname (index.html:340, app.js:581-582)，不再写死默认 topic
任务4: 3 个 interrupt 测试（均为过时测试，不是代码 bug）：
  - claude-interrupt-route.test.js:182 "Queue cleared" → "Resuming with" (9840310 auto-flush)
  - claude-sdk-driver.test.js:218 subtype 'interrupted' → 'error_during_execution' (a33d294)
  - interrupt.test.js:176 sendRaw('\x03') 不再插入 client-side block (a33d294)
  判定依据：最新设计(a33d294+9840310)=打断后 subtype=error_during_execution+auto-flush queue
  run.log: npm test 44/15suite pass=44 fail=0 ✓
任务5: 手机 UI 390x844 截图审查，input-row 按钮 36px→44px (style.css @media max-width:480px)
验收: curl /api/codex/config={"model":"gpt-5.5"} ✓ PORT=3001 health 200 ✓ grep zhiningwork=0 ✓
commit: 待打 QA tag

[QA] Settings面板打磨 A-E（i18n/精简/全局Permission/通知红点/静音/UI修）
根因：无，需求驱动。修法：新建i18n.js轻量翻译模块+Language下拉；删CLI Provider/队列开关/Claude驱动三块；新建全局Permission三档(full-auto/auto-edits/ask)同时驱动Claude+Codex；恢复Codex模型选择器；favicon/title红点+焦点清除；喇叭改为全局静音总控；ntfy默认localhost/zhiningwork；移除"⏵"豆腐块图标
run.log: npm test 44/15suite pass=41 fail=3（均为既有flaky，未引入新失败）✓ 热更新: PORT=3001 health 200 ✓ i18n.js serve ✓ CLI Provider=0 codex-model-select=1 ✓ commit: 7850397

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

[done] Claude Code 界面闪屏 — agent 输出新行时屏幕会闪
[done] 浏览器通知音效 — 文件监控事件（done/blocked/QA）播放提示音
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
[done] 手机滑动不顺滑 — 移动端 xterm 改 pan-y + 收窄 iOS killScroll
[done] Ask Claude 输入框发送方式修改
[done] Claude 界面跳到顶部修复
[done] 语音输入功能
[done] 集成 GPT-SoVITS 语音合成
[done] 部署 GPT-SoVITS 本地 TTS 服务
[done] TTS 各项 bug 修复 (重复/格式/音色/重播等)
[done] QA 信号监听服务
[done] 端口健康检查服务
