# cancong-ops 架构与实现

> 面向维护者。讲清模块划分、存储 schema、索引设计、三个易错点的解法，以及数据生命周期。
> 契约层面见 [API.md](./API.md)，部署运维见 [DEPLOYMENT.md](./DEPLOYMENT.md)。

## 1. 形态与依赖哲学

- **单进程 Node CJS**(无 `type` 字段)，仅 2 个运行时依赖：`express` + `better-sqlite3`。
- **零构建**：看板是 vanilla ESM + vendored uPlot，源码即产物。
- **数据即单个 `.db` 文件**：备份 = 拷文件，PostgreSQL 迁移只动 `lib/db.js` 一层。
- 与主仓库(蚕丛 harness / TechDemos)同栈同哲学，便于对照维护。

## 2. 模块划分

```
server.js            入口：Express 装配 + 生命周期（createApp / gracefulShutdown）
lib/
  db.js              唯一 SQL 层：连接/PRAGMA/迁移/全部 prepared DAO（PG 迁移只动此文件）
  ingest.js          POST /v1/events：校验 + 单事务批插 + 幂等聚合
  stats.js           GET /v1/stats/* + /v1/installs：查询聚合
  aggregate.js       夜间 job：核对补算 + 滚动清理 + 空间回收 + 进程内调度
  time-utils.js      localDay（day 归日）+ shiftDay（日历运算）
public/              看板：index.html + js/{core,features} + css + vendor/uPlot（四页）
scripts/             bench.js（压测）/ seed-demo.js（灌演示数据）/ vendor-uplot.js
deploy/              cancong-ops.service（systemd 单元）
__tests__/           node:test 确定性测试（49 用例）
```

**装配顺序**(`server.js::createApp`)：`express.json(1mb)` → `/healthz` → `/v1` 空 authMiddleware → ingest/stats 路由 → `public/` 静态 → `/v1` JSON 404 → 错误兜底中间件。

**生命周期**：`require.main` 时才 `listen` + `startScheduler` + 注册 SIGINT/SIGTERM。优雅退出逻辑抽为 `gracefulShutdown(scheduler, srv, close, exitFn, timeoutMs)`——停调度器 → `srv.close` 收尾 → 关库退出，3s 兜底强退。测试 `require` 不触发 `listen`。

## 3. 存储 schema

7 张表(`lib/db.js` 中 `DDL_V1`)，通过 `PRAGMA user_version` 迁移。

| 表 | 作用 | 保留 |
|----|------|------|
| `installs` | 实例注册表；心跳只 upsert 此表 | 永久 |
| `events` | 原始事件(session/run/failure)；带固化的 `day` 列 | 滚动 90 天 |
| `daily_user` | 用户维度日聚合(sessions/runs/failures/heartbeats...) | 永久 |
| `daily_tool` | 工具维度日聚合 | 永久 |
| `daily_fail` | 失败维度日聚合(day, app_version, kind) | 永久 |
| `hb_seen` | 心跳幂等去重表 | 7 天 |
| `meta` | 夜间 job 记账(last_job_day / last_job_at / last_job_result) | 永久 |

**PRAGMA 时序**(敏感)：`auto_vacuum = INCREMENTAL` 只对未建表的空库生效，**必须先于 DDL**；`journal_mode = WAL`、`synchronous = NORMAL`、`busy_timeout = 5000`。

**看板查询走聚合、明细走 events**：DAU/会话/工具/失败分布全部预聚合到 `daily_*` 小表，读时零扫描 events；只有"最近失败列表"读原始 events。

## 4. 索引设计(压测驱动)

events 表**不设 `(type, server_ts)` 索引**——所有查询按 `day` 过滤而非 `server_ts`，那样的索引只会白白加重写路径。改用：

```sql
CREATE INDEX ix_events_day    ON events(day);                                    -- 清理 + 补算
CREATE INDEX ix_runend_ver    ON events(day, app_version) WHERE type='bp_run_end';    -- 失败率分母(覆盖)
CREATE INDEX ix_fail_recent   ON events(day, server_ts)  WHERE type='failure_event';  -- 最近列表(反向扫)
```

- `ix_runend_ver`/`ix_fail_recent` 是 **partial 覆盖索引**，只索引 bp_run_end / failure_event 子集，写放大小。
- 最近失败列表用 `ORDER BY day DESC, server_ts DESC` 配合 `ix_fail_recent` 反向扫 + LIMIT 提前终止。
- **`daily_fail` 专为 kinds 分布而设**：直接对 events 做 `json_extract(kind)` 跨天分组要走临时 B 树(30 天约 1 秒)，预聚合成小表后亚毫秒。
- 效果(700 万行实测)：失败按版本从朴素实现的 **23 秒 → 94 毫秒**，全部查询毫秒级；删掉写路径上的无用索引还让写吞吐提升约 10 倍。详见 `scripts/bench.js` 的验收线。

## 5. 三个易错点的解法(实现正确性核心)

### A. 心跳幂等
心跳不落 events(千人级 ~12 万条/日纯浪费)，客户端 spool 补发会重发。解法：`hb_seen(event_id, day)` 去重表，`INSERT OR IGNORE` 后 `changes===1` 才 `heartbeats+1`，保留 7 天(夜间清理)。**夜间补算不重算 heartbeats 列**——events 里没有心跳原始数据，物理不可重算。

### B. day 时区边界
ingest 写入时用 `localDay(now)`(服务器本地时区)算出 `day` 并**固化为 events 列**，此后聚合/清理/查询只认该列，绝不从 ISO 串再推导。`substr(server_ts)` 会得 UTC 日、把北京 00:00–08:00 事件错归前一天；SQLite `'localtime'` 会随进程 TZ 漂移。部署机必须钉死 `TZ=Asia/Shanghai`。

### C. 聚合可重算性(三条铁律)
1. **增量以插入成功为门**：events `INSERT OR IGNORE` 的 `changes===1` 才 bump——ingest 幂等与聚合幂等是同一事务里的同一条件，重发批天然不双计。
2. **补算只覆盖事件派生列**：`ON CONFLICT DO UPDATE SET` 只列 sessions/session_ms/runs_*/failures/run_active_ms；`heartbeats` 永不出现在 SET 列表。
3. **补算窗口 = 最近 3 天**(安全网；events 与 daily bump 同事务，理论无漂移)。

## 6. 数据生命周期

```
上报 → ingest（单事务：校验 → upsertInstall → 幂等门 → 增量 bump daily_*）
                                    │
                              events 原始表（90 天）
                                    │
夜间 job（本地 3:00，setTimeout 链，错过自动补跑，防重入）
  ├─ 核对补算最近 3 天 daily_user/daily_tool/daily_fail（heartbeats 除外）
  ├─ 90 天滚动清理 events（分块 DELETE 避免长事务锁写路径）
  ├─ hb_seen 清理 7 天外
  ├─ PRAGMA incremental_vacuum + wal_checkpoint(TRUNCATE)
  └─ PRAGMA optimize（partial 覆盖索引选取依赖统计保鲜）
                                    │
查询 → stats（走 daily_* / installs，毫秒级；仅 recent 读 events）→ 看板四页
```

## 7. 看板(public/)

单 `index.html` + hash tab 四页(概览/趋势/失败/实例)，vanilla ESM：`js/core/{api,fmt,charts,range}.js` + `js/features/{overview,trend,failures,installs}.js`。图表用 vendored uPlot(挂 `window.uPlot`，经 `core/charts.js` 收口)。60s 自动刷新当前激活页，`document.hidden` 时暂停。失败页最近失败表每行带 `data-event-id`，为 v2 一键提单预留入口。

## 8. 测试

`__tests__/` 共 49 个 node:test 用例：`db`(PRAGMA/迁移/DAO) · `ingest`(幂等/心跳/day 固化/边界/fail-safe) · `stats`(7 端点/范围/除零/坏 payload) · `aggregate`(补算/清理/调度/失败重试) · `server`(装配/404/兜底)。夹具用临时 db 文件(非 `:memory:`，因 WAL 对内存库无效)。`npm run bench` 做 700 万行查询验收。
