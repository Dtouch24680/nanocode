# CLAUDE.md — nanocode

Web 终端工作区：Node.js + Express + xterm.js + WebSocket + node-pty

## 测试命令

```bash
cd /storage/home/zhiningjiao/code/nanocode
npm test
```

## 热更新部署

1. `PORT=3002 node server/index.js &` → 确认 200
2. `kill $(lsof -t -i:3001)` → `PORT=3001 node server/index.js &`
3. 确认 3001 正常后停 3002。**始终保证至少一个端口可用。**

## Git 远程

- `origin` — victoriacity/nanocode（上游，只读）
- `zhi` — ZhiNningJiao/nanocode（本地代码所基于的 fork，只读）
- `myfork` — Dtouch24680/nanocode（push 到这里）

## 无人值守

用 `/ralph-loop` 启动。身份标识 `[nanocode]`。
通用 SOP 见全局 CLAUDE.md。
