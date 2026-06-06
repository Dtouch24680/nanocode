# Recent Agents Resume Fix Report

## 问题描述
点击右侧 Recent Agents 列表中的会话条目，期望看到历史聊天记录并能接着对话。
实际表现：tab 空白，没有历史，发消息也不走 --resume 而是开新 session。

## 根因 Bug 1: 两步 create+patch 竞态（主因，history 空白）

旧流程：
1. POST /api/projects/:id/tabs -> 新 tab 带随机 UUID 作为 claudeSessionId
2. 服务端立刻 WS broadcast -> 客户端 _addTab -> ClaudeBlockRenderer._connect()
3. WS 打开 -> _fetchAndReplayHistory() 用错误的随机 UUID 拉历史 -> 空结果
4. PATCH /api/.../session 到达时 CBR 已完成 history fetch，不再重拉

修复：POST body 直接带 claudeSessionId。

## 根因 Bug 2: 首条消息 --session-id 而非 --resume

旧逻辑 turnCount 始终从 0 开始，isFirstTurn=true 用 --session-id 开新会话。
修复：buildReplaySeed 返回 hasHistory，attachClaudeSession 据此设 initialTurnCount=1。

## 根因 Bug 3: 新 tab 不自动聚焦

_pendingActiveId 在 HTTP response 后才设，WS broadcast 可能已经跑完 _applyServerTabs。
修复：同时设 _pendingActiveId 并检查 tab 是否已在列表，两路都覆盖。

## 验证结果

- history 正确加载: [Restored 1 event(s) from session history]
- Claude 用 --resume 接上下文: turn=2, cache_read=16322
- 自动聚焦: 工作正常
