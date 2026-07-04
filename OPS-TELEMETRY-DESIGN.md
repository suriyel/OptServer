# 运营统计服务器（ops-server）+ 遥测客户端 统一设计文档

> 状态：澄清已对齐，待评审 → 服务器端另建独立仓库实现
> 日期：2026-07-02
> 范围：新独立服务器端（ops-server，单独建库）+ 本仓库客户端模块（server-telemetry/）的统一设计

## 1. 背景与目标

为本工具（蚕丛 harness）独立开发一个运营服务器，用于查看**使用人数、活跃度等现状**；后续扩展为**异常失败快速提单反馈**、**监听会话中用户负反馈并收集相关上下文**以持续优化。

两端统一设计的核心：**事件信封（envelope）schema 是双端唯一契约**，v1 只发 usage 类事件，v2 的 ticket/feedback 事件复用同一信封与传输层；**查询聚合 API 是看板唯一契约**，看板只是可替换消费者（日后如需 Grafana 可挂同一套 API，不动存储与采集层）。

### 非目标（v1）

- 不做鉴权（内网即信任；预留中间件挂点）
- 不做多节点 HA / 负载均衡
- 不做告警推送（数据齐备，后续可加 webhook）
- 不接 Grafana（已讨论否决：无现成平台，为单工具自运维一套过重，且 v2 应用形态覆盖不了；API 契约保留随时接入的可能性）
- 不收集会话内容本身（v2 负反馈上下文收集需专章澄清隐私红线后再设计）

## 2. 关键决策（澄清结论）

| # | 议题 | 结论 | 含义 |
|---|------|------|------|
| Q1 | 部署环境 | **公司内网直连** | 所有实例（含远端 Linux 虚机）可直连内网地址，无需代理链路 |
| Q2 | 用户身份口径 | **系统用户名 + 主机名** | `os.userInfo().username` + `os.hostname()` 自动采集，零录入；辅以 installId 防重名/换机 |
| Q3 | v1 采集指标 | **四类全采** | 实例心跳与版本 / 会话活动 / 蓝图运行统计 / 失败异常事件 |
| Q4 | 消费形态 | **自建薄看板** | ops-server 自带零构建看板页（vanilla ESM + vendored 图表库） |
| Q5 | 规模量级 | **按千人级设计** | 容量测算见 §8；SQLite WAL + 增量聚合可承载，预留 PostgreSQL 迁移路径 |
| Q6 | 代码组织 | **服务器端独立新仓库** | 本文档即建库依据；客户端模块在本仓库 `server-telemetry/` |
| Q7 | 数据保留 | **原始 90 天 + 聚合永久** | 夜间滚动清理 events 表；日聚合表永久保留看趋势 |
| Q8 | 访问控制 | **内网即信任，不鉴权** | 上报与看板均不设鉴权；代码预留 auth 中间件挂点 |

## 3. 架构总览

```
┌─ 本仓库（每个使用者机器，Windows / 远端 Linux 同一份 server.js）──────┐
│  server.js 生命周期钩子 ──显式 emit──▶ server-telemetry/            │
│   · onListening（实例上线）            · collect.js  采集/限流       │
│   · pty.spawn / child.onExit（会话）    · identity.js 身份/installId │
│   · 蓝图 run 终态收敛点（运行统计）      · spool.js   断网落盘缓冲     │
│   · error-autoresume 等（失败事件）     · sender.js  批量 flush      │
└──────────────────────────────┬──────────────────────────────────┘
                    POST /v1/events（批量，fail-open，8s 超时）
                               ▼
┌─ ops-server（独立仓库，内网单进程 Node + Express + better-sqlite3）──┐
│  ingest（校验+幂等+增量聚合） ──▶ SQLite（events 原始 + daily 聚合）  │
│  夜间 job：聚合补算 + 90 天清理                                      │
│  GET /v1/stats/*（查询聚合 API，看板唯一契约）                        │
│  public/ 自建看板（概览/趋势/失败/实例 四页，零构建）                  │
└──────────────────────────────────────────────────────────────────┘
```

设计原则（客户端铁律）：

1. **fail-open**：ops-server 不可达/超时/任何异常，静默降级（仅 debug 日志），绝不影响 harness 主流程——镜像 `fetchOpencodeLatestVersion()`（server.js:295）先例：内置 https、8s 超时、失败即弃。
2. **不丢不阻塞**：事件先入内存队列，定时批量 flush；失败落本地 spool 文件，恢复后补发；spool 有上限，超限丢最旧。
3. **可一键关**：settings 开关 + env 强关双门控。

## 4. 统一事件信封（双端唯一契约）

```jsonc
{
  "schemaVersion": 1,
  "eventId": "uuid",              // 客户端生成；服务器按此幂等去重（重发安全）
  "type": "session_start",        // 见下表；v2 直接扩展新 type，信封不变
  "ts": "2026-07-02T09:30:00+08:00", // 客户端本地时刻（ISO）；聚合以服务器接收时刻为权威（防时钟漂移）
  "installId": "uuid",            // 首启生成，持久化于 DATA_ROOT（每数据目录一个）
  "user": "zhangsan",             // os.userInfo().username
  "host": "DESKTOP-XXXX",         // os.hostname()
  "platform": "win32",            // process.platform
  "appVersion": "1.4.0",          // package.json version
  "channel": "packaged",          // packaged | dev（Electron isPackaged / env 判定，看板可过滤开发噪声）
  "bootId": "uuid",               // 每进程启动生成，区分同 install 的多次启动
  "payload": { }                  // type 专属字段
}
```

**用户口径**：去重键 = `user@host`（同一人多个 DATA_ROOT 实例不重复计人）；installId 用于实例/安装维度统计与换名兜底。

### v1 事件类型与 payload

| type | 触发点 | payload |
|------|--------|---------|
| `instance_online` | server listen 成功 | `{ port, liveSessions: 0 }` |
| `instance_heartbeat` | 定时 5min ± 随机抖动 | `{ liveSessions }`（**不落 events 原始表**，见 §7） |
| `session_start` | PTY spawn 成功 | `{ tool, cwdHash }` |
| `session_end` | PTY onExit | `{ tool, cwdHash, durationMs, exitCode }` |
| `bp_run_start` | launchRun 新建 run | `{ blueprintId, runId, tool }` |
| `bp_run_end` | run 终态（done/failed/halted） | `{ blueprintId, runId, status, activeMs, haltReason? }` |
| `failure_event` | 异常信号（见 §6.3） | `{ source, kind, reason, tool, runId? }` |

**隐私约定（v1）**：不上传 cwd 明文、prompt、会话内容、代码。`cwdHash = sha256(cwd 规范化).slice(0,12)` 仅用于"项目数"统计。blueprintId 为内部工作流名，可上传（有"哪个工作流最常用"的统计价值）。

### v2 预留类型（本期只定型不实现）

| type | 用途 | payload 骨架 |
|------|------|--------------|
| `ticket` | 异常失败一键提单 | `{ ticketId, title, note, failureRef: eventId, envSnapshot }` |
| `feedback` | 负反馈上下文收集 | `{ trigger: 'neg_hint'\|'manual', consent: true, contextRef }` |

## 5. 身份与实例标识（客户端 identity.js）

- **installId**：首启 `randomUUID()`，持久化 `DATA_ROOT/telemetry/install.json`。每个 HARNESS_DATA_DIR 一个（多实例并行各有其 id，与既有隔离模型一致）。
- **user/host**：每次启动现取，不缓存（换用户/改名自然生效）。
- **bootId**：进程内存态，每次启动新生成。
- **远端 Linux 实例**：跑同一份 server.js，同一套采集自然生效；内网直连可达即上报。`HARNESS_EXEC_ONLY` 远端实例的 channel 仍按实际判定，可在 payload 维度区分（host 即虚机名）。

## 6. 客户端设计（本仓库 `server-telemetry/`）

### 6.1 模块结构与挂载

```
server-telemetry/
  index.js       // createTelemetry(ctx) → { emit(type, payload), shutdown() }；模块入口与总开关判定
  identity.js    // installId 读写 + user/host/version/channel 采集
  collect.js     // 各挂接点的适配与限流（failure_event 每小时 cap 30/实例）
  spool.js       // DATA_ROOT/telemetry/spool.jsonl：失败落盘、上限 10MB 丢最旧、恢复补发
  sender.js      // 内存队列 + 30s 定时批量 flush（≤500 事件/批）+ 心跳定时器；https POST，8s 超时，fail-open
  __tests__/     // node --test 确定性测试（本地 stub HTTP server，零外网）
```

挂载遵循既有 `server-xxx/` 惯例：server.js 在 `onListening()` 成功后初始化（此处真实端口/DATA_ROOT 已就绪），得到单例 `telemetry`，各挂接点显式调 `telemetry.emit(type, payload)`。**不新增 WS 通道、不新增前端桥**。

### 6.2 挂接点清单（实现时逐点核实行号）

| 事件 | 挂接位置 | 说明 |
|------|---------|------|
| instance_online / heartbeat | `onListening()`（server.js:7098 一带） | 上线即发一条 + 启动 5min 心跳定时器 |
| session_start | `spawnAndAttach()` 内 pty.spawn 成功、`startedAt` 落定处（server.js:6599 一带） | 会话元数据（tool/cwd/startedAt）已在 child 上 |
| session_end | `child.onExit()`（server.js:6928 一带） | durationMs = now − startedAt |
| bp_run_start | `launchRun()` 新建 run 分支（server-blueprint/routes.js:651 一带） | 续跑不重发（按 runId 判新建） |
| bp_run_end | **state 写入收敛点检测终态跃迁**（prev.status → done/failed/halted 时 emit，runId 去重） | 终态写点分散（routes.js:1022/2075/2377/2483、chain-engine.js、engine.js:748/779），在 state-io 写入口做单点检测最稳，镜像 completion.js「三完成信号分流 + runId 去重」的思想；若实现时核实存在绕过 state-io 的写点，则逐点埋 + 去重兜底 |
| failure_event | error-autoresume `_emit()`（error-autoresume.js:210 一带）旁挂 phase=classifying 的分类结果；halted 的 haltReason 随 bp_run_end 携带；stall-patrol cap_exhausted 可选补充 | source ∈ error_autoresume / halt / stall_patrol |

### 6.3 开关与配置（三层）

| 层 | 键 | 行为 |
|----|-----|------|
| env 强关 | `HARNESS_TELEMETRY=0`（进 server-config/env-registry.js） | 一键全关，ST/CI 用（st fixtures 统一置 0，不污染数据，也不新增 ST 观测面） |
| settings 开关 | `settings.telemetryEnabled`（默认 true） | 走既有三段链路：profiles.json → `/api/settings` GET/PUT → global-settings.js 面板 checkbox（UI 文案「使用统计上报」） |
| endpoint | `HARNESS_TELEMETRY_ENDPOINT` env ▷ `settings.telemetryEndpoint` ▷ 代码内 DEFAULT 常量（发布时钉内网地址） | endpoint 为空 = 天然关闭（开发态默认常量留空，发布构建/env 注入） |

### 6.4 传输与可靠性

- 事件 → 内存队列（上限 5000 条，超限丢最旧）→ 每 30s 批量 `POST /v1/events`（≤500/批）。
- 发送失败 → 整批追加 spool.jsonl；下轮 flush 先补发 spool 再发新事件；spool 超 10MB 截断最旧。
- 心跳独立定时器（5min ± 30s 抖动，摊平千实例早高峰同刻上报）。
- `shutdown()`：进程退出前尽力 flush 一次（不阻塞退出，500ms 上限）。
- eventId 幂等：补发/重发由服务器 `INSERT OR IGNORE` 去重，客户端无需精确一次。

## 7. 服务器端设计（独立仓库，暂名 `cancong-ops`）

### 7.1 仓库结构（同栈同哲学：Node CJS、零构建、仅 2 个依赖）

```
cancong-ops/
  server.js            // 入口：Express 单进程，PORT env（默认 5900），/healthz
  lib/
    db.js              // better-sqlite3 打开（WAL）、schema 迁移、DAO——唯一 SQL 层（PG 迁移只动此文件）
    ingest.js          // /v1/events：校验、幂等、installs upsert、daily 增量聚合
    aggregate.js       // 夜间 job：日聚合补算核对 + events 90 天清理 + incremental_vacuum
    stats.js           // /v1/stats/* 查询聚合 API
  public/              // 自建看板（vanilla ESM 零构建，vendored uPlot）
  __tests__/*.test.js  // node --test
  package.json         // dependencies: express, better-sqlite3
```

部署：内网 Linux 服务器 `node server.js` + systemd 单元（Restart=always）；数据即单个 .db 文件，备份 = 拷文件。

### 7.2 存储 schema（SQLite，WAL，synchronous=NORMAL）

```sql
-- 安装/实例注册表（心跳只 upsert 此表 + daily_user 计数，不落 events —— 千人级心跳 ~12 万条/日，落原始表纯浪费）
CREATE TABLE installs (
  install_id TEXT PRIMARY KEY,
  user TEXT, host TEXT, platform TEXT, app_version TEXT, channel TEXT,
  first_seen TEXT, last_seen TEXT, live_sessions INTEGER DEFAULT 0
);

-- 原始事件（session/run/failure；保留 90 天）
CREATE TABLE events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id TEXT UNIQUE,            -- 幂等去重
  install_id TEXT, user TEXT, host TEXT,
  type TEXT, client_ts TEXT, server_ts TEXT,
  app_version TEXT, payload TEXT   -- JSON
);
CREATE INDEX ix_events_type_ts ON events(type, server_ts);
CREATE INDEX ix_events_install_ts ON events(install_id, server_ts);
CREATE INDEX ix_events_ts ON events(server_ts);              -- 清理用

-- 日聚合（永久保留；ingest 时增量 upsert，夜间 job 核对补算）
CREATE TABLE daily_user (
  day TEXT, install_id TEXT, user TEXT, host TEXT,
  heartbeats INTEGER DEFAULT 0, sessions INTEGER DEFAULT 0, session_ms INTEGER DEFAULT 0,
  runs_done INTEGER DEFAULT 0, runs_failed INTEGER DEFAULT 0, runs_halted INTEGER DEFAULT 0,
  failures INTEGER DEFAULT 0,
  PRIMARY KEY (day, install_id)
);
```

- `day` 按服务器本地日（Asia/Shanghai）切分，存 `YYYY-MM-DD`——遵循「ISO 存储、本地展示」既有约定，聚合边界与使用者作息一致。
- 聚合以 `server_ts` 为权威（客户端时钟不可信，client_ts 仅参考留档）。
- 天级总量（DAU、总会话等）从 daily_user 现查（千人级 × 一年 ≈ 25 万行，group by day 毫秒级），不单设 totals 表。

### 7.3 API

```
POST /v1/events            # { events: [envelope...] } ≤500/批 → { ok, accepted, dup }
GET  /healthz

GET  /v1/stats/overview    # 今日活跃用户/在线实例(last_seen<10min)/本周活跃/今日会话与run数
GET  /v1/stats/dau?from&to # 逐日 DAU/WAU、会话数、会话时长
GET  /v1/stats/versions    # 版本分布（按 install 最新心跳）
GET  /v1/stats/tools?from&to    # 各工具会话占比与时长
GET  /v1/stats/runs?from&to     # run 数与终态分布（done/failed/halted）、activeMs
GET  /v1/stats/failures?from&to # 失败类型分布、按版本失败率、最近失败事件列表（读 events）
GET  /v1/installs          # 实例明细列表（user/host/version/platform/last_seen）
```

不鉴权（Q8），但所有路由统一挂 `app.use('/v1', authMiddleware)` 空实现——未来加 token 只改一处。

### 7.4 自建看板（public/，零构建）

四页，全部只打 `/v1/stats/*`：

1. **概览**：今日活跃 / 在线实例 / 周活跃 / 版本分布环图 / 工具占比
2. **趋势**：DAU/WAU 曲线、会话数与时长曲线、run 终态堆叠柱
3. **失败**：失败类型分布、按版本失败率、最近失败事件表（v2 提单的入口位）
4. **实例**：明细表（user/host/版本/平台/最后在线），支持排序过滤

图表库 vendored uPlot（~40KB，无依赖，时序性能好），沿本项目 vanilla ESM 风格；时间展示走本地化。

## 8. 千人级性能设计

### 8.1 数据量测算（1000 活跃实例）

| 项 | 估算 | 结论 |
|----|------|------|
| 心跳 | 5min × ~10h 在线 ≈ 120 条/实例/日 → 12 万/日 | **不落 events**，upsert installs + daily_user 计数，原始表零压力 |
| 会话事件 | 人均 ~30 会话/日 × 2 ≈ 6 万/日 | 落 events |
| run + 失败事件 | ~1.5 万/日（失败客户端限流 30/h/实例） | 落 events |
| events 表规模 | ~8 万/日 × 90 天 ≈ **700 万行** | SQLite 千万行 + 覆盖索引常规水位 |

手段汇总：批量 ingest 单事务插入；心跳不落原始表；增量聚合（读时零扫描 events）；心跳抖动摊峰；90 天滚动清理 + `PRAGMA incremental_vacuum` 控制库体积（约 3–5 GB 内）。

### 8.2 吞吐测算与压力场景

**写路径（ingest，唯一有量的路径）**：

| 场景 | 请求率 | 行写入率 | 事件循环占用 |
|------|--------|---------|------------|
| 日常平均 | < 5 req/s | ~1 行/s | <1% |
| 持续活跃上限 | ~33 req/s（千实例每 30s 各 flush 一批） | 数百行/s | ~3% |
| 早高峰开机 | +17 req/s 瞬时（千实例同一分钟内上线；心跳另有 ±30s 抖动摊平） | — | 可忽略 |
| 极端：宕机多日后恢复 | ~33 req/s 持续约 30 分钟（千实例 spool 满载 10MB ≈ 3 万事件/实例，各按每 30s 一批 500 条补发） | ~1.7 万行/s | ~20–25% |

承载依据：WAL + `synchronous=NORMAL` 下提交不强制 fsync（checkpoint 才落盘），单事务批插 500 行约 5–10ms；Express 单进程 + 进程内 SQLite 这一形态本身可扛 500–1000 req/s 量级的此类小请求，**需求峰值仅 35，余量约两个数量级**。天然背压已在设计内：客户端 fail-open + spool 重试意味着服务器过载时即使直接拒绝（如返回 429），数据不丢、稍后自动补发——无需引入队列中间件。

**读路径（看板）**：消费者为个位数人员，每页 4–8 个 stats 查询、30–60s 自动刷新，读 QPS 为个位数。overview/versions 扫 installs（1000 行）<1ms；90 天 DAU 走 daily_user 主键前缀范围扫（9 万行 group by）5–20ms；唯一潜在慢点是**多年跨度趋势**（daily_user 累积至数百万行时 group by 可达 100–300ms）——属偶发慢查询而非吞吐问题，备用旋钮见 §8.3。

### 8.3 缓存层结论：不引入独立缓存组件

高速缓存层（Redis 等）解决的两个问题——高读 QPS 与昂贵重算——本系统均不存在（读 QPS 个位数、最贵查询百毫秒级）。SQLite 是进程内库，热数据页（daily_user 全表几十 MB）天然驻留 OS page cache、无网络往返；外置缓存反而**增加**一跳网络 + 一个运维组件 + 失效一致性问题，与"内网单进程、拷文件即备份"的部署形态相悖。写路径为 append-only + upsert，缓存亦无益。

若日后某查询实测变慢，备用旋钮两个（成本递增，均非 v1 工作）：

1. **进程内 stats 响应 memo**：`/v1/stats/*` 结果按 30–60s TTL 缓存于内存 Map（约 10 行代码），与看板刷新节奏对齐；数据本为分钟级新鲜度，无失效难题——这是本规模下"缓存层"的合理形态。
2. **物化 daily_totals**：多年趋势查询变慢时，夜间 job（aggregate.js 挂点已留）把天级总量物化为"一天一行"表（几千行，永远毫秒级）。

### 8.4 PostgreSQL 迁移触发条件

预留路径，非 v1 工作：实例数 >5000、需多节点 HA、或库 >20GB。所有 SQL 收敛在 `lib/db.js` 单文件 DAO，SQL 方言保持 ANSI 化，迁移只动此层。

## 9. v2 扩展设计（预留，不实现）

信封与传输层不变，只增 type；本仓库信号源已成熟，届时直接复用：

1. **异常失败快速提单**：看板"失败"页/客户端失败提示处一键提单 → `ticket` 事件（关联 failure_event 的 eventId + 环境快照 + 用户备注）→ ops-server 增 tickets 表与最小状态流转（open/closed）+ 看板工单页。失败打底数据 v1 已在采集。
2. **负反馈收集**：复用 BRM 记录员 `detectIntervention()`（server-blueprint/memory/recorder.js:80，NEG_RE 负向措辞/中途插话检测）作为触发信号 → **征得用户同意后** 经 server-context `getSessionRecords()` 切片打包 → `feedback` 事件上传。
3. **隐私红线（v2 前置澄清项）**：会话上下文含代码与 prompt——脱敏规则、授权粒度（每次询问/一次授权）、可上传内容白名单，须在 v2 设计时专章澄清后才动工。

## 10. 测试策略

- **cancong-ops**（独立库）：node --test 确定性——ingest 幂等（重发 dup）、增量聚合正确性、90 天清理边界、stats 端点快照；无浏览器无 LLM。
- **本仓库 server-telemetry/**：`server-telemetry/__tests__/*.test.js`（node --test，纳入全量后端测试 glob）——身份持久化、spool 落盘/超限丢最旧/恢复补发、fail-open（端点不通时主流程零影响、无未捕获异常）、限流 cap；用本地 stub HTTP server，零外网。
- **ST**：不新增 ST lane（遵循「唯一 ST 一条线」铁律）；st fixtures 统一 `HARNESS_TELEMETRY=0`，保证既有 ST 不受影响也不产生脏数据。

## 11. 里程碑

| 阶段 | 交付 | 验收 |
|------|------|------|
| M1 契约冻结 | 本文档 §4（信封）+ §7.3（API）评审定稿 | 双端依据一致 |
| M2 ops-server | 独立库：ingest + 存储 + 聚合 + stats API + 夜间 job + 测试 | node --test 全绿；本地灌 700 万行压测查询毫秒级 |
| M3 客户端 | server-telemetry/ 采集 + spool + 设置开关 + env 门控 + 测试 | 后端测试全绿；`npm run st` 不回归；断网/关端点零影响 |
| M4 看板 | 四页看板 | 真数据可视 |
| M5 灰度 | 先小范围试点（endpoint 手动配置）→ 发布默认 endpoint 全量 | 数据口径与实际人数对得上 |
