# CLAUDE.md — nanocode

Web 终端工作区：Node.js + Express + xterm.js + WebSocket + node-pty

## 测试命令

```bash
cd /storage/home/zhiningjiao/code/nanocode
npm test
```

## 热更新部署

默认端口 **9475**（常驻；`server/index.js` 的 `PORT` 默认值已设为 9475）。

1. `PORT=9476 node server/index.js &` → 确认 200
2. `kill $(lsof -t -i:9475)` → `node server/index.js &`（默认即 9475）
3. 确认 9475 正常后停 9476。**始终保证至少一个端口可用。**

## Git 远程

- `origin` — victoriacity/nanocode（只读）
- `fork` — ZhiNningJiao/nanocode（push 到这里）
- PR: `gh pr create --repo ZhiNningJiao/nanocode`

## 无人值守

用 `/ralph-loop` 启动。身份标识 `[nanocode]`。
通用 SOP 见全局 CLAUDE.md。
