# nanocode：气泡可点击路径/URL + 消息队列方案C +（配套）codex 文档约定

日期：2026-06-03
分支：zhining/nanocode-selfresume-bugs

## 背景
主人两个痛点：
1. claude 忙时发消息只能排队（`[queued position N]`），不能即时插话。
2. claude 发给 codex 的信息看不到（codex 在独立 tmux，nanocode 没接）。

主人定的解法（原话）：
- 队列：「C 两者都做」= 排队 / 打断并发送二选一。
- codex 可见性：不做 tmux 实时镜像，改「文档约定 + 气泡可点击」轻方案。「加强这俩功能这样也能用了」。
- 路径点击：「explorer 支持啥我就能点啥。反正就一个信号的事儿」= 气泡识别路径 + 发信号，explorer 负责打开。
- URL：所有 http(s)（含内网 10.18.8.55）自动解析成可点链接。

## 功能一：消息队列方案 C
- busy 时发消息 → 前端给二选一：**排队**（等当前回合，维持现有 enqueue + position 提示）或 **打断并发送**。
- 打断并发送：调用已有 interrupt 路由（`POST .../interrupt`，SIGINT 中断当前回合且**不杀后台 sub-agent** —— 已验证的不变量），中断后立即发送这条。
- 后端 interrupt + queue 已存在，主要是前端交互（发送时的选择 + 调 interrupt 再发）。

## 功能二：气泡路径可点 → 发信号给 explorer
- renderer 在文本/代码/系统消息里识别文件系统路径（绝对 `/storage/...` 与 repo 相对路径），渲染成可点元素。
- 点击 → 派发 CustomEvent（如 `nanocode:open-in-explorer` {path}），**复用 explorer 现有的打开/预览入口**（先定位现有文件树打开逻辑，别新造渲染）。explorer 支持什么类型就开什么（md/code/image…）。
- 识别要稳：避免把普通词/带斜杠的非路径误判；优先匹配已知 repo 根下路径与 `~/`、`/storage/home/...`。

## 功能三：URL 自动解析可点
- renderer 把纯文本里的裸 `http(s)://...`（含 `http://10.18.8.55/...`）自动链接化为 `<a target="_blank" rel="noopener noreferrer">`。
- markdown 渲染的链接已可点；本功能补「裸 URL autolink」。
- 复用已有 `.cbr-text a` 样式（含 word-break 防溢出）。

## 功能四（配套）：codex 文档约定 —— claude 侧 skill，秘书自行维护
- 约定 claude↔codex 协作文件落固定位置：任务书 `codex_work/<slug>/task.md`、回报 `report.md`、DONE flag；`dispatch-codex` 派活时把这些**路径 echo 进对话流**。
- 这样配合功能二，气泡里就有可点路径，主人点开即在 explorer 看「交代了啥 / codex 干了啥」。
- 改 `~/.claude/skills/dispatch-codex/SKILL.md`（非 nanocode repo），不在本次 sonnet 任务内，由秘书 claude 单独更新。

## 测试与部署（nanocode 功能一~三）
1. `npm test 2>&1 | tee run-bubble.log`，grep 干净。
2. 起 3002（3001 不动）。
3. 真机端到端（真 nanocode 界面）：① busy 时发消息出现「排队/打断并发送」，打断后台 agent 不被杀；② 点气泡里一个路径 → explorer 打开对应文件；③ 点气泡里一个 URL（含 10.18.8.55）→ 浏览器新标签打开。截图存 demo-toolblocks/bubble-*.png。
4. 全绿后重启 3002，commit + push fork，不开 PR。

## 边界 / YAGNI
- 路径/URL 识别用保守正则，宁可漏判不可错杀正常文本。
- 不做 codex tmux 实时镜像（主人明确放弃）。
