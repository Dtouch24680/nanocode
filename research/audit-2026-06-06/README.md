# Audit 2026-06-06 — nanocode 查漏补缺审计

审计日期：2026-06-06  
审计员：claude-sonnet-4-6（调研 agent）  
触发：主人提问"就现在的实现有哪些不是官方的？尽可能替换成官方的，并且 block 渲染还有哪些有开源库可以参考？"

---

## TL;DR

1. **最大自造轮子**：slash 命令硬编码 30 条 → init 事件已有 106 条（含所有 plugin 命令），一次改动可永远同步。
2. **init 事件宝库未挖**：`model`、`fast_mode_state`、`plugins[]`、`agents[]`、`skills[]`、`memory_paths` 都在 init 事件里，nanocode 几乎不用任何。
3. **block 渲染最大缺口**：Edit/Write 无 diff 视图（竞品全有）、无 thinking block 折叠、无 image inline、无 mermaid/KaTeX。
4. **历史/session 部分无官方 API 可换**：`~/.claude/projects/*.jsonl` 的读取和 session GC 是正确方向，官方没有对应 query API。

---

## 文件索引

| 文件 | 内容 |
|---|---|
| [nanocode_vs_official.md](./nanocode_vs_official.md) | 21 条自实现 vs 官方对照表，每条有 file:line 引用 + 切换难度 + 收益评估 |
| [block_rendering_opensource.md](./block_rendering_opensource.md) | 12 个开源项目 block 渲染调研（LibreChat/open-webui/continue/sugyan/cloudcli/opencode/streamdown 等）+ 库对比表 |
| [feature_gap_priority.md](./feature_gap_priority.md) | 18 条查漏补缺，P0/P1/P2/P3 分级，每条带 motivation + 位置 + 估时（总 ~39h） |

---

## 最紧急 3 条

- **P0-1**：slash commands 动态化（2h，防 plugin 命令永久丢失）
- **P1-1**：Edit/Write diff 渲染（4h，用户体验关键缺口）
- **P1-2**：session init block 显示 model 名（0.5h，几乎免费的信息展示）
