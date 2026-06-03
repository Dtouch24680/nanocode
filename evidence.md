# Evidence — "点击停止的时候，别停 subagent"

任务: nanocode 点 Stop / Ctrl+C 中断主 agent 这轮生成时，不要连带杀掉这轮派生的 subagent / 子进程。

## 真实传播路径（trace + 实测）

Stop 按钮 → `public/js/terminal-view.js:288` → `POST /api/projects/:id/tabs/:tabId/interrupt`
→ `terminal/routes.js` interrupt 路由 → `cs.currentProc.kill('SIGINT')`。

`cs.currentProc` = `spawn('bash', ['-lc', 'claude --print …'])`（stream-json 桥，routes.js runClaudeTurn）。
node 的 `child_process.kill(sig)` 把信号发给 **proc.pid 单个正 pid**，不是负 pid（进程组），也没有 SIGKILL、没有升级定时器。bash 收到 SIGINT 后转发给前台子进程 claude，claude 中断本轮。

PTY 路径（`terminal/sessions.js` 的 `_proc.kill()`）只用于 bash tab 的 restart/destroy，**不是 Stop 按钮**，与本任务无关。

## 实测进程树证据（.interrupt-probe/，复刻 routes.js 的 spawn）

四个 probe 都复刻 `spawn('bash',['-lc','claude --print …stream-json…'])` + 相同 env strip，turn 进行中发 `proc.kill('SIGINT')`，用 ps 验进程树。

| probe | 子进程如何启动 | SIGINT 后 | 结论 |
|---|---|---|---|
| probe1 (probe-run-1.log) | Bash 工具 `nohup … &`（自分离） | **存活** PPID=1 PGID=自身 | 分离的子进程不受影响 |
| probe2 (probe-run-2.log) | Bash 工具前台命令（未分离） | **被杀** GONE | claude 自身 abort 时杀掉正在等待的前台子进程（非 nanocode 发的信号） |
| probe3 (probe-run-3.log) | **Task 工具 subagent** 里 `setsid nohup …` | **存活** PPID=1 PGID=SID=自身 `Ss` | subagent 分离出去的后台进程存活 |
| probe4 (probe-run-4.log) | 验证 `detached:true` 改动 | turn 干净中断(`result/error_during_execution`) + 分离子进程**存活** | 改动不破坏中断，且强化隔离 |

probe3 关键输出:
```
[probe3] marker pid=98418 launched ... before: 98418  1  98418  98418 Ss   bash
[probe3] >>> SIGINT to bash child pid=98152
[probe3] result/error_during_execution
[probe3] after interrupt: 98418  1  98418  98418 Ss   bash
[probe3] DONE marker-survived=true
```

## 结论：是否可修

- **nanocode 这一侧已经是最干净的做法**：单个正 pid 的 SIGINT，从不发进程组信号(负 pid)、从不 SIGKILL、无升级。Stop 不会从 OS 层面把 subagent 扫掉。
- subagent / 子进程**会不会活下来，取决于它在 claude 内部如何启动**，不在 nanocode 控制范围：
  - 分离启动（`setsid` / `nohup &` / `run_in_background`，进入自己的 session/进程组）→ **存活**（probe1/3/4）。
  - 前台、未分离的 Bash 工具子进程 → 被 claude 自己的 abort 逻辑杀掉（probe2），nanocode 从外部无法阻止。
  - **in-process Task subagent 的「推理过程」** 随父 turn 中断而结束，这是 **Claude Code harness 层面的固有行为，nanocode 改不了**。只有 subagent 派生到独立 session 的 OS 进程能存活。

## 改动（nanocode 侧能做的强化）

`terminal/routes.js` runClaudeTurn 的 spawn 加 `detached: true`：把本轮 `bash -lc claude` 隔离进自己的进程组/session。
- Stop 行为不变（仍是单 pid SIGINT，probe4 验证中断正常）。
- 防御性：即使将来有任何进程组级信号打到 nanocode，也不会波及 subagent 分离出去的工作。
- 未加 `proc.unref()`：本轮是前台生成，应随 worker 一起退出，detached 仅用于进程组隔离。

interrupt 路由注释改写为实测结论 + 必须维持的不变量（永不改 kill(-pid)、永不加 SIGKILL 升级）。

## 验证
- `node --check terminal/routes.js` / `terminal/sessions.js` → OK
- `npm test` → 6 pass / 0 fail
- `node --test terminal/tests/*` → 30 pass / 6 skipped / 0 fail
- run.log 中我的两次运行均 `# fail 0`（219-258 行的 cbr_ FAIL 是更早 session 跑浏览器 e2e 时的历史内容，按 SOP 不截断 run.log）。
