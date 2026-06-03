# nanocode：全局渲染模式开关 + 设置界面瘦身 + agent-list 增强

日期：2026-06-03
分支：zhining/nanocode-selfresume-bugs

## 背景
主人三个诉求：(1) claude tab 渲染能在「block 渲染」与「原版终端(PTY raw)」间切换；(2) 设置界面文案太长、找不到东西，要瘦身重组；(3) agent-list 显示最近还活着的 agent，点击可续聊（复用已做的按目录 jsonl 会话恢复）。

主人原话（关键决策）：
- 渲染模式：「还是全局吧，没必要 pertab，直接放 setting 里。我改了之后基本不想改回去了，留着兜底而已。」→ **全局**设置，默认 block，terminal 仅兜底。
- 设置界面：「setting 这个页面里文本太长，找半天找不到想要的。简短并重新组织。」→ 痛点是**冗长 + 难找**，目标是砍描述、紧凑、分组清晰，**不是加内容**。
- agent-list：「24h 内或最近五个。万一放长假了呢。」→ **24h 内全部，但保底永远至少最近 5 个**，放假回来不空。「就是这个 agentlist 增强」。

## 功能一：全局渲染模式开关
- 在全局 settings 存 `renderMode`：`block`(默认) | `terminal`(PTY raw 原始流，兜底)。
- 后端两条路径已存在（routes.js：stream-json bridge vs `exec bash -l` PTY raw）；本功能让 claude tab 按全局 `renderMode` 选择走哪条。
- UI：设置面板里一个开关/radio（Block 渲染 / 原版终端），无 per-tab 控件。
- 切换后：新开/重连的 claude tab 生效（已开 tab 重连时应用）。
- 数据流：settings → store.settings.renderMode → tab 连接时读取决定渲染路径。
- 错误处理：renderMode 缺失/非法 → 回退 block。

## 功能二：设置界面瘦身重组
- 现状 `index.html` settings-panel 各 section 带长 `settings-desc`，散乱难找。
- 改：删除/压缩冗长描述（每项最多一行 hint 或无），紧凑间距，重组为三组带清晰标题：
  - **会话**：CLI Provider、渲染模式
  - **显示**：tool fold 等级、subagent prompts、subagent activity
  - **服务监控**：端口/服务状态（现有）
- 纯前端：index.html 结构 + CSS 紧凑化 + app.js 绑定不破坏现有功能。
- 验证：现有所有开关（fold/subagent/CLI provider）行为不回退。

## 功能三：agent-list 增强（最近活着 + 点击续聊）
- 后端新增 `GET /api/recent-agents`：扫 `~/.claude/projects/*/*.jsonl`，按 mtime 降序；规则 = **取 mtime 在 24h 内的全部；若结果不足 5 个，补齐到最近 5 个**（放假容错）。跨所有 project。
- 每条返回：project 名（从目录名反解 cwd）、sessionId、最后活动时间(mtime)、首条 user prompt 摘要、是否活跃(24h 内)。
- 前端增强 `public/js/agents.js` 的 agent-list：渲染上述字段，活跃/idle 用点标记；点击某项 → 打开/切到对应 project 并用**已实现的 jsonl 会话恢复**（GET history 回放 + 选中对应 session tab）加载续聊。
- 复用：功能依赖此前已合入的会话恢复（routes.js history 端点 + tab-manager 自动恢复 + uuid 去重）。
- 错误处理：jsonl 解析失败的目录跳过；摘要取不到显示「(无摘要)」；点击的 session 文件不存在时回退到该 project 最新 jsonl。

## 边界 / YAGNI
- 不做 24h 内超多 agent 的分页（当前规模无需）；如单次结果过长可截到合理上限并标注。
- 渲染模式不做 per-tab、不做每项额外配置。

## 测试与部署
1. `npm test 2>&1 | tee run.log`，grep 干净。
2. 起 3002（3001 原版不动，保证至少一端口可用）。
3. **真机端到端**（真 nanocode 界面，非 demo）：① 设置里切 terminal/block 各验渲染；② 设置面板瘦身后所有开关可用、布局紧凑截图；③ agent-list 显示最近会话、点击其一成功回放续聊。截图存 demo-toolblocks/feature-*.png。
4. 全绿后重启 3002。
