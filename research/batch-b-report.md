# Batch B 实施报告

日期：2026-06-06  
分支：zhining/nanocode-selfresume-bugs  
Commit：7add0bb

---

## 任务完成情况

### P1-3: settings 加 model + effort 下拉（完成）

**改动文件：**
- `terminal/routes.js:1268-1306`：`runClaudeTurn` 读取 `claude_model` / `claude_effort` store 值，非空时追加 `--model` / `--effort` 到 launchArgs
- `public/index.html`：settings 会话区新增两个 `<select>`（id: `claude-model-select`、`claude-effort-select`）
- `public/js/app.js`：`loadClaudeModelSettings` / `loadClaudeEffortSettings` 在 `loadSettings()` 中调用；Save 按钮调 `updateSetting`

**验证：**
```
PUT /api/settings {"key":"claude_model","value":"claude-sonnet-4-5"} → {"ok":true}
PUT /api/settings {"key":"claude_effort","value":"high"} → {"ok":true}
GET /api/settings → claude_model: claude-sonnet-4-5, claude_effort: high
```
默认值 = 空字符串，`launchArgs` 不追加 `--model` / `--effort`，行为与改前完全一致。

---

### P1-4: auth status 显示（完成）

**改动文件：**
- `server/index.js`：新增 `GET /api/auth/status` 路由，`execFile('claude', ['auth', 'status', '--json'], {timeout:5000})` + 60s 内存 cache
- `public/index.html`：settings 会话区顶部新增 `id="auth-status-display"` div
- `public/js/app.js`：`loadAuthStatus()` 函数；`openSettingsPanel()` 每次打开时调用

**验证：**
```
curl http://127.0.0.1:3001/api/auth/status
{
  "loggedIn": true,
  "authMethod": "claude.ai",
  "email": "zhiningjiao@meshy.ai",
  "orgName": "Meshy",
  "subscriptionType": "team"
}
```
前端显示：`登录账号：zhiningjiao@meshy.ai (claude.ai)`（绿色）

---

### P2-5: permission mode 选择（完成）

**改动文件：**
- `terminal/routes.js:1285-1295`：permission_mode 映射：
  - `bypass` → `--dangerously-skip-permissions`（维持现状）
  - `accept-edits` → `--permission-mode acceptEdits`
  - `auto` → `--permission-mode auto`
- `public/index.html`：settings 会话区新增三个 radio（id group: `claude-permission-mode-group`）
- `public/js/app.js`：`loadPermissionModeSettings` + save 按钮处理

**验证：**
```
PUT /api/settings {"key":"claude_permission_mode","value":"accept-edits"} → {"ok":true}
```
默认 `bypass`，与改前行为 100% 一致。`claude --help` 确认 `--permission-mode` flag 支持 `acceptEdits`/`auto`。

---

### P3-3: session --name flag（完成）

**改动文件：**
- `terminal/routes.js:1487-1503`：`attachClaudeSession` 初始化 `cs` 时加 `tabLabel: tab?.label || ''`
- `terminal/routes.js:1301-1302`：`runClaudeTurn` 非空时追加 `--name tabLabel`

**验证：**
tab.label 非空时 launchArgs 含 `--name <label>`；空时不追加，安全。

---

## 红线检查

- `public/js/claude-block-renderer.js`：未触碰 ✓
- `public/js/terminal-view.js`：未触碰 ✓
- 默认行为：permission_mode 默认 `bypass`，等同改前的 `--dangerously-skip-permissions` ✓
- 未 force push / merge main / 开 PR ✓

---

## 服务状态

3001 已热重启运行新代码，PID 264302，curl 200。

---

## 文件位置

- `terminal/routes.js`：launchArgs 改动在 ~1268-1310
- `server/index.js`：auth status 路由在 ~130-163
- `public/index.html`：新增 DOM 在 ~185-239（settings 会话区）
- `public/js/app.js`：新增 JS 在 ~675-785（settings panel tab switch 之前）
