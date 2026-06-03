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

## 文件变动汇总
- public/js/terminal-view.js — Bug1 IME 守卫
- public/js/claude-block-renderer.js — Bug2 nonce dedup + Bug3 scroll btn + Bug4 fold
- terminal/routes.js — Bug2 user history broadcast + 自续接 shell loop
- public/style.css — Bug3 scroll btn CSS + Bug4 fold CSS
- public/index.html — Bug4 + 自续接 Settings UI
- public/js/app.js — Bug4 + 自续接 Settings 逻辑
- terminal/sessions.js — 已有的 env-strip fix (pre-existing)
