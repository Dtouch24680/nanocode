# Evidence — Bug1-5 + 自续接功能

## 测试结果
```
npm test 2>&1 | tee run.log
# tests 6 / pass 6 / fail 0
grep -i "FAIL|Error|NOT FOUND" run.log → "# fail 0" (only match)
```

## 服务启动验证
```
PORT=3099 node server/index.js &
curl http://localhost:3099/api/health → {"status":"ok"}
```

## Commits
- 06c41e7 — fix(Bug1): IME composition guard in terminal-view.js
- 000687f — fix(Bug2+Bug3+Bug4+自续接): claude-block-renderer.js + routes.js
- 1cf2bd1 — fix(Bug3+Bug4): CSS for scroll-to-bottom + tool fold levels
- 78d7d4b — feat(settings): tool-fold radio + auto-resume toggle in settings panel
- 9ca1b73 — fix(Task A): tool blocks fold + tool output invisible (root fix)
- 03beb00 — feat(Task B): subagent visibility toggles
- 60a731a — fix(Bug2): clear scroll before history replay on reconnect
- 7e9c0d6 — fix: gate subagent assistant/partial activity behind toggle

## 文件变动汇总
- public/js/terminal-view.js — Bug1 IME 守卫
- public/js/claude-block-renderer.js — Bug2 nonce dedup + Bug3 scroll btn + Bug4 fold + subagent toggles
- terminal/routes.js — Bug2 user history broadcast + 自续接 shell loop
- public/style.css — Bug3 scroll btn CSS + Bug4 fold CSS
- public/index.html — Bug4 + 自续接 Settings UI
- public/js/app.js — Bug4 + 自续接 Settings 逻辑
- terminal/sessions.js — 已有的 env-strip fix (pre-existing)

---
## 独立验收 (2026-06-03)

### 验收方法
- npm test: 6/6 PASS, grep FAIL/Error run.log → "# fail 0"
- PORT=3099 server 启动: GET /api/health → 200 ✓
- 5 项 server integration tests (HTTP + WebSocket): 5/5 PASS
- Shell loop 逻辑验证脚本 (qa-test/test-shell-loop.sh): 3/3 PASS
- IME guard unit tests (qa-test/test-ime-guard.js): 6/6 PASS
- Bug2 nonce dedup unit tests (qa-test/test-bug2-nonce.js): 6/6 PASS
- Bug3 scroll button visibility unit tests (qa-test/test-bug3-scroll.js): 6/6 PASS
- Bug4 tool fold unit tests (qa-test/test-bug4-tool-fold.js): 5/5 PASS (CSS fallback confirmed via Node.js)
- Subagent toggle unit tests (qa-test/test-subagent-toggles.js): 9/9 PASS
- node --check all modified JS files → syntax OK

### 验收结论: 全部 PASS
1. 自续接 Launcher: PASS — shell loop 逻辑正确; 秒退检测防死循环; 3s 倒计时; 设置开关持久化
2. Bug1 IME 回车: PASS — compositionstart/end flag + e.isComposing + keyCode 229 三重守卫
3. Bug2 用户消息可见: PASS — server 存 history; nonce dedup 防双渲染; reconnect 清空再回放
4. Bug3 滚到底按钮: PASS — 距底>60px 显示; 点击滚底; 到底隐藏; CSS 过渡动画
5. Bug4 折叠+工具输出: PASS — tool_result 现在正确渲染; :not([data-fold]) 兜底 CSS; 三档切换
6. Subagent 开关: PASS — 两个独立开关; 默认值正确; 即时生效(DOM style); 刷新保持(localStorage)
