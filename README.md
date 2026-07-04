# cancong-ops

蚕丛 harness 的运营统计服务器：接收各实例上报的使用事件（`POST /v1/events`），SQLite 存储 + 增量聚合，提供查询聚合 API（`GET /v1/stats/*`）与自建看板（概览/趋势/工作流/用户/失败/实例 六页）。

契约与设计依据：[OPS-TELEMETRY-DESIGN.md](./OPS-TELEMETRY-DESIGN.md)——§4 事件信封（双端唯一契约）、§7.3 查询 API（看板唯一契约）。

技术形态：Node CJS 单进程，仅 2 个运行时依赖（express + better-sqlite3），零构建（看板为 vanilla ESM + vendored ECharts），数据即单个 `.db` 文件。

**文档**：[docs/](./docs/) — [API 契约](./docs/API.md) · [架构与实现](./docs/ARCHITECTURE.md) · [部署与运维](./docs/DEPLOYMENT.md) · [Release Notes](./docs/RELEASE-NOTES.md)

## 快速开始

```bash
npm ci
npm start                 # 默认 http://localhost:5900
```

打一批样例事件：

```bash
curl -s -X POST http://localhost:5900/v1/events -H 'content-type: application/json' -d '{
  "events": [{
    "schemaVersion": 1, "eventId": "demo-1", "type": "session_start",
    "ts": "2026-07-02T09:30:00+08:00", "installId": "demo-install",
    "user": "zhangsan", "host": "DESKTOP-X", "platform": "win32",
    "appVersion": "1.4.0", "channel": "packaged", "bootId": "b1",
    "payload": { "tool": "claude", "cwdHash": "abcdef012345" }
  }]
}'
# → {"ok":true,"accepted":1,"dup":0}；重发同批 → accepted 0 / dup 1（eventId 幂等）
```

浏览器打开 `http://localhost:5900` 即看板（概览 / 趋势 / 失败 / 实例）。

## 环境变量

| 变量 | 默认 | 说明 |
|------|------|------|
| `PORT` | `5900` | 监听端口 |
| `OPS_DB_PATH` | `./data/ops.db` | SQLite 路径（目录自动创建） |
| `OPS_RETENTION_DAYS` | `90` | events 原始表保留天数（daily 聚合表永久） |

## 时区（重要）

`day` 归日在 ingest 写入时按**进程本地时区**固化为列，此后聚合、清理、查询只认该列。部署机必须钉死时区（systemd 单元里 `Environment=TZ=Asia/Shanghai`）；**上线后不要改 TZ**，否则新旧数据的日界口径不一致。

## 数据与运维

- **存储**：`installs`（实例注册，心跳只 upsert 此表）、`events`（原始事件，滚动保留）、`daily_user` / `daily_tool` / `daily_fail`（日聚合，永久）、`hb_seen`（心跳幂等，7 天）、`meta`（job 记账）。SQL 全部收敛在 `lib/db.js`（PostgreSQL 迁移只动此文件；触发条件见设计文档 §8.4：实例 >5000 / 需 HA / 库 >20GB）。
- **看板查询走聚合、明细走 events**：DAU/会话/工具/失败分布等全部预聚合到 `daily_*` 小表，读时零扫描 events；只有「最近失败列表」读原始 events。events 上不设 `(type, server_ts)` 索引（无查询按 `server_ts` 过滤），改为 `day` 先导索引 + 两个 partial 覆盖索引（失败率分母、最近失败列表）。这套设计由 `npm run bench` 在 700 万行上验证：全部查询毫秒级（失败按版本从朴素实现的 23 秒降到个位数毫秒）。`daily_fail(day, app_version, kind)` 专为 kinds 分布而设——直接对 events 做 `json_extract(kind)` 跨天分组要走临时 B 树（30 天约 1 秒），预聚合成小表后亚毫秒。
- **夜间 job**（进程内，本地 3:00，错过自动补跑）：最近 3 天聚合核对补算（heartbeats 列除外——心跳不落 events，不可重算）→ 90 天清理 → `incremental_vacuum` + WAL checkpoint。
- **备份**：在线执行 `sqlite3 ops.db "VACUUM INTO '/backup/ops-YYYYMMDD.db'"`，或停服后拷全套文件。**WAL 模式下不要只拷 `.db` 主文件**（`-wal` 里可能有未 checkpoint 的数据）。
- **部署**（内网 Linux）：`npm ci --omit=dev`（better-sqlite3 有 linux-x64 glibc 预编译；musl/无网环境需 `build-essential + python3` 兜底编译）→ `deploy/cancong-ops.service` 装入 systemd。

## 开发

```bash
npm test                  # node:test 确定性测试（无外网、无浏览器）
npm run bench             # 700 万行压测：灌数 → 全量重算 → 逐查询 p50/p95 对照验收线
npm run vendor            # 升级 echarts/字体后重拷 public/vendor/（vendored 产物提交进 git）
```

目录：`lib/`（db 唯一 SQL 层 / ingest / stats / aggregate / time-utils）、`public/`（看板：js/core + js/features 分层）、`__tests__/`、`scripts/`、`deploy/`。

## API 速览

```
POST /v1/events            # { events: [envelope…] } ≤500/批 → { ok, accepted, dup }
GET  /healthz
GET  /v1/stats/overview    # 今日/周活跃、在线实例(<10min)、今日会话与 run
GET  /v1/stats/dau?from&to # 逐日 DAU/WAU、会话数、时长（from/to 本地日，含端点，缺省近 30 天）
GET  /v1/stats/versions    # 版本分布（近 30 天活跃实例）
GET  /v1/stats/tools?from&to
GET  /v1/stats/runs?from&to
GET  /v1/stats/failures?from&to   # 类型分布、按版本失败率、最近失败（受 90 天保留窗约束）
GET  /v1/stats/users/top?from&to&metric&limit  # 高频用户 Top N（metric 排序）
GET  /v1/stats/blueprints?from&to # 各工作流 runs/失败/E2E/中断/token
GET  /v1/stats/realtime?window=   # 近 24h 按分钟直查 events（实时视图）
GET  /v1/installs          # 实例明细
```

不鉴权（内网即信任）；`/v1` 统一挂 `authMiddleware` 空实现，未来加 token 只改 `server.js` 一处。
