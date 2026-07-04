# Release Notes

本文件记录 cancong-ops 各版本的变更。遵循「面向使用者的价值 + 面向维护者的关键实现」双视角。

---

## v0.2.0 — 2026-07-04

工作流/用户/Token 统计扩展。新增两个看板页与两个查询端点，覆盖高频用户、Token 消耗、工作流使用与失败归因。

### 新增能力
- **工作流页**：各工作流(内部 blueprintId)的运行数、终态分布、失败归因、E2E 活跃时长(activeMs)、用户中断次数、Token 消耗，表头可排序。
- **用户页**：Top 10 高频用户，支持按会话数/run 数/Token/活跃时长/失败数切换排序。
- **Token 统计**：概览页今日 Token 卡片、趋势页输入/输出 Token 曲线、用户与工作流维度的 Token 归因。
- **失败对应工作流**：失败页最近失败表新增「工作流」列；`failure_event` 带 `blueprintId` 时归因到具体工作流。
- 新端点 `GET /v1/stats/users/top`(metric 白名单排序)、`GET /v1/stats/blueprints`；`overview`/`dau` 增 Token 字段。
- **看板视觉升级**：「精密仪表盘」暗色设计系统(amber+cyan 信号色、IBM Plex Mono 等宽数字、载入错峰揭示、脉冲在线点)；用户页/工作流页引入 vendored **ECharts** 图表(横向排名条形 / 运行终态堆叠条形，指标可切换)，趋势页仍用 uPlot。

### 契约扩展(客户端需上报的 payload 字段)
- `session_end`：`inputTokens`/`outputTokens`(token 总量权威)。
- `bp_run_end`：`inputTokens`/`outputTokens`(工作流归因)、`interruptions`(用户中断)。
- `failure_event`：`blueprintId`(失败归因，可选)。
- 未上报前，相关指标 graceful 显示为 0/空。

### 关键实现要点
- **Token 防重复计数**：会话 token(→`daily_user`) 与 run token(→`daily_blueprint`) 分别聚合、互不重复求和(run token 是会话 token 子集)。见 [ARCHITECTURE.md §3](./ARCHITECTURE.md#token-防重复计数关键设计)。
- **术语**：对外统一「工作流」，内部沿用既有 `blueprint`/`blueprintId`/`bp_run_*` 契约，不改名。
- 新增 `daily_blueprint` 聚合表 + `daily_user` 两个 token 列，与 daily_tool/daily_fail 同法(增量 upsert + 夜间可重算)。
- **质量保障**：63 个 `node:test` 用例(含 token 防双计、失败→工作流归因、metric 白名单)；`npm run bench` 700 万行两新端点毫秒级(users/top 21ms、blueprints 0.4ms)；看板经浏览器实测两新页 + metric 切换通过。

---

## v0.1.0 — 2026-07-04

蚕丛 harness 运营统计服务器首个版本。交付里程碑 **M2(后端)+ M4(看板)**，可独立部署、灌真实数据、看板可视。

### 新增能力

**上报与存储(M2)**
- `POST /v1/events` 批量上报接口：单事务批插、按 `eventId` 幂等去重、断网补发安全(`accepted/dup/rejected` 三计数)。
- SQLite(WAL)存储 + 增量聚合：events 原始表(90 天滚动)+ `daily_user`/`daily_tool`/`daily_fail` 永久聚合表。
- 7 类 v1 事件：实例上线/心跳、会话起止、蓝图 run 起止、失败事件；未知 type 前向兼容(只存不聚合)。

**查询 API 与看板(M4)**
- 7 个查询端点：`overview`/`dau`/`versions`/`tools`/`runs`/`failures`/`installs`，统一 `{ok,data}` 契约。
- 自建四页看板(概览/趋势/失败/实例)：vanilla ESM 零构建 + vendored uPlot，60s 自动刷新。

**运维**
- 进程内夜间 job：本地 3:00 核对补算 + 90 天清理 + 空间回收，错过自动补跑、失败自动重试。
- systemd 单元、优雅退出(SIGINT/SIGTERM)、`/healthz` 探活。

### 关键实现要点

- **三个易错点专项处理**：心跳幂等(`hb_seen` 去重表)、day 时区固化(写入时按本地日固化为列)、聚合可重算性(增量以插入成功为门、补算不碰 heartbeats 列)。详见 [ARCHITECTURE.md §5](./ARCHITECTURE.md#5-三个易错点的解法实现正确性核心)。
- **压测驱动的索引设计**：700 万行压测暴露 events 缺 `(type, day)` 索引导致失败页查询全类型扫描(byVersion **23 秒**)。删掉无用的 `(type, server_ts)` 索引、改 `day` 先导 + 两个 partial 覆盖索引、新增 `daily_fail` 聚合表。修复后全查询毫秒级(byVersion **94ms**、kinds **0.12ms**、dau-90 **110ms**)，写吞吐提升约 10 倍。
- **质量保障**：49 个 `node:test` 确定性用例(幂等/心跳/时区/边界/fail-safe/调度)，`npm run bench` 700 万行查询验收全 PASS，看板经浏览器实测四页渲染通过。

### 技术栈

- Node.js ≥ 18 纯 CJS，仅 2 个运行时依赖(`express` ^5.1.0 + `better-sqlite3` ^12.10.0)，零构建。
- 数据即单个 `.db` 文件，备份 = 拷文件；PostgreSQL 迁移路径预留(只动 `lib/db.js`)。

### 非目标(v1 明确不做)

- 不做鉴权(内网即信任，预留 `authMiddleware` 挂点)。
- 不做多节点 HA / 负载均衡 / 告警推送。
- 不收集会话内容本身(prompt/代码)——v2 负反馈上下文需专章澄清隐私红线后再设计。

### 文档

- [API.md](./API.md) — 上报与查询接口契约
- [ARCHITECTURE.md](./ARCHITECTURE.md) — 架构、schema、索引、三个易错点
- [DEPLOYMENT.md](./DEPLOYMENT.md) — 部署、env、日志、备份、故障排查
