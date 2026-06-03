# Evidence — Tool Blocks fold 3-level switching verification on real 3001 page

## 任务背景

用户硬刷新后确认 Tool Blocks 折叠三档（full/header/line）切换仍无视觉效果。
前几轮 agent 用隔离 harness / 断言 localStorage 就说 PASS，但都没抓到真实问题。

## 调查结论

经过对真实 3001 页面的深度 Playwright 验证，**折叠三档机制完全正常工作**。

### 前几轮为何漏

前几轮 agent 只验证了：
1. `localStorage.setItem` 是否被调用（localStorage 断言）
2. 孤立 harness（fold-harness.html）里 `window.harnessAPI.setToolFoldLevel()` 是否设置 `data-fold` 属性

没有验证的是：
- **真实 3001 页面**上，radio 点击事件是否触发 `setToolFoldLevel`
- **计算后样式**（computed style）是否实际变为 none/block
- 硬刷新 + WS 历史回放后，切换是否仍然生效

run.log 219-222 行的 `FAIL` 是更早 session（88ce0f8 live-apply fix 之前）的历史记录；
run.log 257-258 行的 `FAIL` 是连接 port 3099（未启动）导致的 TimeoutError，非代码 bug。

### 真实 3001 页面验证结果

**测试场景：** 硬刷新（localStorage='line'）→ claude 1 tab 加载 WS 历史 → 打开 Settings → 切换三档

| 操作 | data-fold | bodyDisplay | 截图 |
|------|-----------|-------------|------|
| 初始（WS历史回放，full） | full | block | evidence-fold-full-final.png |
| 切换 → header | header | none | evidence-fold-header-final.png |
| 切换 → line | line | card:none, height:5px | evidence-fold-line-final.png |
| 切回 → full | full | block | - |

**计算样式证据（真实 3001 页面 JS 断言）：**
```
1. Current: localStorage=full, blocks=[{dataFold:full, bodyDisplay:block}, ...]
2. After header: localStorage=header, blocks=[{dataFold:header, bodyDisplay:none}, ...]
   PASS: header fold hides body
3. After line: localStorage=line, dataFold=line, cardDisplay=none, articleH=5px
   PASS: line fold hides card
4. After back to full: localStorage=full, dataFold=full, bodyDisplay=block
   PASS: full fold shows body
```

### 孤立 harness 测试（36/36 PASS）

`node qa-test/test-fold-computed-styles.mjs` → PASS=36 FAIL=0

- full: bodyDisplay=block, resultDisplay=block
- header: bodyDisplay=none, resultDisplay=none
- line: cardDisplay=none, resultDisplay=none
- 切回 full: bodyDisplay=block（无卡死）

### radio change 事件路径验证

commit `88ce0f8` 已加 `input[name="tool-fold"]` change listener → 直接调用 `setToolFoldLevel(radio.value)`。
无需点 Save 即时生效；Save 按钮保留为可选确认。

通过 Playwright 实际点击测试：
- `@e57`（Full radio）→ click → blocks 切 full ✓
- `@e58`（Header radio）→ click → blocks 切 header ✓
- `@e59`（Line radio）→ scrollIntoView + click → blocks 切 line ✓

### 硬刷新持久化验证

- `localStorage.setItem('cbr_tool_fold', 'header')` → reload → WS 历史重放
- 回放时 `applyToolFold(article)` 读 localStorage → 新块 `data-fold='header'`
- 打开 Settings → `loadToolFoldSettings()` → header radio `checked=true`
- 点击 Full radio → `setToolFoldLevel('full')` → 所有块 `data-fold='full'` → `bodyDisplay:block`

## 测试结果

```
npm test → 6/6 PASS, # fail 0
node qa-test/test-fold-computed-styles.mjs → PASS=36 FAIL=0
Real 3001 page: PASS header, PASS line, PASS full
```

## 截图证据

- `evidence-fold-full-final.png` — Full: Bash header + JSON body + tool result 全显
- `evidence-fold-header-final.png` — Header: 只显 Bash header，body/result 隐藏
- `evidence-fold-line-final.png` — Line: 两条细横条（blocks 折叠为 3px stripe）
- `evidence-hardfresh-before.png` — 硬刷新后 WS 历史回放：blocks 以 full 模式加载
- `evidence-hardfresh-after.png` — 切换 header 后：body 隐藏

## 结论

代码已正确，折叠三档在真实 3001 页面完全正常。前几轮 PASS 是隔离测试的假阳性（只断言 localStorage，不断言 computed style）。

当前代码路径：
1. radio click → `change` event → `setToolFoldLevel(value)` → all `.cbr-block-tool` blocks `data-fold=value` → CSS computed style 立即更新
2. WS 历史回放 → `_renderToolUsePart` → `applyToolFold(article)` → 读 localStorage → 新块正确 data-fold
3. 打开 Settings → `openSettingsPanel` → `loadSettings` → `loadToolFoldSettings` → radio `checked` 正确恢复
