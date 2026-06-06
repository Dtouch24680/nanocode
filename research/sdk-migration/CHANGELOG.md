# SDK Migration Plan CHANGELOG

---

## v1 → v2（2026-06-06）

### 输入

- Codex 对抗审核: `~/codex_work/SDK_PLAN_CODEX_REVIEW.md`（claude SDK PLAN，6 必修项）
- Codex 对抗审核: `~/codex_work/CODEX_SDK_PLAN_CODEX_REVIEW.md`（codex SDK PLAN，7 必修项）
- Phase B1 实证: `~/codex_work/sdk_b1_smoke/REPORT.md`（claude SDK 7 case 实测）
- Codex SDK smoke: `~/codex_work/codex_sdk_smoke/output/`（6 case 实测）

---

### PLAN.md（Claude SDK）v1 → v2

| # | 必修项 | v1 问题 | v2 改动 | 引证 |
|---|---|---|---|---|
| 1 | interrupt 不是 drop-in | 标为"低风险 S"，放在 Phase B POC | 改为"高风险"，移到 Phase C 专项；注明 smoke 证实 `error_during_execution` 非 `interrupted` subtype | SDK_PLAN_CODEX_REVIEW.md:18-41 |
| 2 | Team 订阅计费 | 写了 Pro=$20/月、Max 5x=$100/月（错误） | 替换为 Team Standard $20/seat、Team Premium $100/seat，per-user 不 pooled；超额策略说明 | SDK_PLAN_CODEX_REVIEW.md:44-68；`claude auth status` 输出 `subscriptionType: "team"` |
| 3 | queue/active-guard 不能删 | 标为"低/中风险，可简化" | 重分类为"design work"，列出 queue 三个职责；active-guard 保留 | SDK_PLAN_CODEX_REVIEW.md:72-94 |
| 4 | /resume 拦截保留 | 标为"低风险，可删拦截逻辑" | 改为"保留到 recent-session parity 存在" | SDK_PLAN_CODEX_REVIEW.md:98-113 |
| 5 | history 不无缝迁 | 标为"低风险，jsonl 格式兼容" | 强调 output shape 不同，需 adapter 层；移到 Phase D | SDK_PLAN_CODEX_REVIEW.md:116-134；B1 REPORT 验证 |
| 6 | OAuth 商用受限 | 泛化为"SDK 支持 OAuth" | 限定为"本地/内部 nanocode wrapper"；外部分发需 API key | SDK_PLAN_CODEX_REVIEW.md:138-159 |
| B1 | Cross-dir resume 全失败 | 未提 | 添加"高风险"条目，Phase B2 必须保留 cwd-aware session 映射 | sdk_b1_smoke/REPORT.md:156-174 |
| B2 | Thinking 漂移 | 未提 | 添加"高风险"条目，Phase B2.5 独立验证门禁 | sdk_b1_smoke/REPORT.md:237-270 |
| 路线图 | Phase 重排序 | B-C-D-E-F-G-H-I-J-K（顺序混乱）| B1(完成)/B2/C/D/E（按 codex review 建议顺序）| SDK_PLAN_CODEX_REVIEW.md:213-223 |

---

### CODEX_SDK_PLAN.md（Codex SDK）v1 → v2

| # | 必修项 | v1 问题 | v2 改动 | 引证 |
|---|---|---|---|---|
| 1 | SDK 默认 bundled binary | 写"SDK 调用系统 codex binary，不 bundle" | 改为"bundled-first，findCodexPath() 解析 @openai/codex-linux-x64"；`codexPathOverride` 是显式兼容 mode | CODEX_SDK_PLAN_CODEX_REVIEW.md:93-116；dist/index.js:159-166 |
| 2 | 系统 codex 版本错误 | 写"系统 codex 0.134.0，路径 ~/.local/bin/codex" | 改为"实际 0.125.0，路径 /storage/home/zhiningjiao/code/.local/bin/codex" | CODEX_SDK_PLAN_CODEX_REVIEW.md:118-141 |
| 3 | AbortSignal 不是干净中断 | 标为"中风险 S，创建 AbortController 即可" | 改为"独立 Phase C 研究"；smoke 全部 AbortError，无结构化中断事件 | CODEX_SDK_PLAN_CODEX_REVIEW.md:143-183；abort_sleep*.meta.json |
| 4 | reasoning 不可见 | 列为"有改善 S" | 标注"smoke 未观测到 reasoning item"，不承诺 reasoning UI parity | CODEX_SDK_PLAN_CODEX_REVIEW.md:189-213；raw_reasoning.jsonl |
| 5 | adapter 太扁平 lossy | 平坦化 text/tool/file 类型 | 替换为 lifecycle-aware envelope（provider/phase/item lifecycle/item_id/item_kind/payload），移到 UNIFIED_ADAPTER.md | CODEX_SDK_PLAN_CODEX_REVIEW.md:215-279 |
| 6 | PTY 删除是产品变化 | 标为"低风险，可删 1415 行" | 注明默认 raw PTY terminal mode；删除是用户可感知变化；PTY fallback 保留到 B2/C | CODEX_SDK_PLAN_CODEX_REVIEW.md:283-308；tab-manager.js:370 |
| 7 | approval flow 未解决 | 简单标注"高风险，需研究" | 明确仅 `approvalPolicy: 'never'` 是迁移目标，on-request 不在路线图 | CODEX_SDK_PLAN_CODEX_REVIEW.md:311-323 |

---

### UNIFIED_ADAPTER.md（新文档）

- **新建**：整合 codex review 的 lifecycle-aware envelope schema 建议
- 替代 v1 CODEX_SDK_PLAN.md 第五章的扁平化 `NanocodeAgentEvent` 草案
- 包含 claude SDK 和 codex SDK 的完整映射表
- 前端消费指引
- 来源：`CODEX_SDK_PLAN_CODEX_REVIEW.md:257-279`（schema）+ `SDK_PLAN_CODEX_REVIEW.md:186-211`（recommended phase scope）
