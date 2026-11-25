# cancong-ops 部署与运维

> 面向运维。内网单进程 Linux 部署，数据即单个 `.db` 文件。

## 1. 环境要求

- **Node.js ≥ 18**(纯 CJS，无构建步骤)。
- `better-sqlite3` 有 linux-x64 glibc 预编译；musl(Alpine)或无网环境需 `build-essential + python3` 兜底本地编译。
- 单机即可，无需多节点/负载均衡(v1 非目标)。

## 2. 安装与启动

```bash
git clone <repo> /opt/cancong-ops && cd /opt/cancong-ops
npm ci --omit=dev          # 只装运行时依赖(express + better-sqlite3)；ECharts/字体已 vendored 进 public/
npm start                  # 等价 node server.js，默认 http://localhost:5900
```

> `public/vendor/` 里的 ECharts 与字体已随仓库提交，`--omit=dev` 不会缺文件。

## 3. 环境变量

| 变量 | 默认 | 说明 |
|------|------|------|
| `PORT` | `5900` | 监听端口 |
| `OPS_DB_PATH` | `./data/ops.db` | SQLite 路径(目录自动创建) |
| `OPS_RETENTION_DAYS` | `90` | events 原始表保留天数(daily 聚合表永久) |
| `OPS_ADMIN_USER` | `admin` | 预置管理员用户名(仅首次库中无 admin 时生效) |
| `OPS_ADMIN_PASSWORD` | `admin123` | 预置管理员初始密码；用默认值时启动打印告警，务必改 |
| `OPS_SESSION_DAYS` | `7` | 登录会话有效期天数 |
| `OPS_SECURE_COOKIE` | 关 | 设为 `1` 时会话 Cookie 带 `Secure`(HTTPS 部署用) |
| `OPS_RELEASES_DIR` | `./releases` | 应用更新发布区目录，见 §9.1 磁盘规划 |
| `OPS_EVOLVE` | 不设 | 共部署的自进化服务 cancong-evolve：`:5901`（同主机相对，共部署推荐）/ 绝对 URL（另一台机器：供客户端上报，它指向的主机也是 `/v1/internal/persons` 放行的来源；人员接口只按来源放行，没有共享密钥）/ 不设（没有）。经 `GET /v1/discovery` 告诉客户端与看板（见 `docs/DEPLOYMENT.md` §8.1） |
| `TZ` | 系统时区 | **必须钉死为 `Asia/Shanghai`**，见下 |

## 4. 时区(重要)

`day` 归日在 ingest 写入时按**进程本地时区**固化为列，此后聚合、清理、查询只认该列。

- 部署机**必须**在 systemd 单元里钉死 `Environment=TZ=Asia/Shanghai`。
- **上线后不要改 TZ**，否则新旧数据的日界口径不一致，历史聚合会漂移。
- Windows 开发机本身是 +8，天然一致。

### 4.1 改 TZ 对「作息维度」的额外破坏

`day` 与时段聚合对 TZ 的敏感方式**不同**，这是最容易踩的地方：

| | 口径来源 | 改 TZ 的后果 |
|---|---|---|
| `events.day` / `daily_*` | ingest **写入时固化**成列 | 只影响此后的新数据；历史行原样不动，可查可对账 |
| 时段聚合(`daily_hour`) | 回填脚本按**运行时当前 TZ 现算** | 改 TZ 后重跑回填，结果与增量积累的行**不一致**，同表混两套小时口径，**从数据本身看不出来** |

处置：**别改**。若确有必要（如迁机房换时区），流程是 **停服 → 改 TZ → 清空 `daily_hour` 整表重跑回填**，绝不能只补跑增量。`day` 列的历史漂移无法修复，只能接受并在报表上标注切换日。

## 5. systemd 部署

仓库已带 `deploy/cancong-ops.service`：

```ini
[Unit]
Description=cancong-ops telemetry server
After=network.target

[Service]
Type=simple
User=ops
WorkingDirectory=/opt/cancong-ops
ExecStart=/usr/bin/node server.js
Restart=always
RestartSec=3
Environment=TZ=Asia/Shanghai
Environment=PORT=5900
Environment=OPS_DB_PATH=/var/lib/cancong-ops/ops.db

[Install]
WantedBy=multi-user.target
```

```bash
cp deploy/cancong-ops.service /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now cancong-ops
systemctl status cancong-ops
```

> 单元未设 `OPS_RELEASES_DIR`，发布区落在 `WorkingDirectory` 下的 `/opt/cancong-ops/releases`，**`User=ops` 必须对该目录有写权限**，且所在盘要留出约 1.2GB（见 §9.1）。要挪到数据盘就加一行 `Environment=OPS_RELEASES_DIR=/var/lib/cancong-ops/releases`。

## 5.1 升级已有部署（schema 迁移）

schema 版本由 `PRAGMA user_version` 驱动，服务启动时自动迁移。**建议停服后先单独跑迁移再启动新代码**，避免建索引期间持写锁把上报堵在 `busy_timeout=5000` 上：

```bash
systemctl stop cancong-ops
git pull && npm ci --omit=dev
npm run migrate -- --db /var/lib/cancong-ops/ops.db   # 报告迁移前后 user_version + 耗时；幂等，重复跑安全
systemctl start cancong-ops
npm run backfill -- --db /var/lib/cancong-ops/ops.db  # 仅升级到 v4/v5 时需要一次，见下
```

脚本不复制任何 DDL——直接调 `lib/db.js` 的 `openDb()`（仓库里迁移的唯一真源），不会与 `MIGRATIONS` 数组漂移。库不存在时**报错退出而非静默造空库**（那只意味着 `--db` 打错了）。当前最新版本 **v5**（v3 加 `ix_update_recent` 索引；v4 加两条 `ALTER TABLE ... ADD COLUMN last_at TEXT` + `ix_daily_user_recency`——可空、无 DEFAULT、无约束的 `ADD COLUMN` 在 SQLite 是**纯元数据操作**，不重写表、O(1)，几百万行也是毫秒级；v5 只 `CREATE TABLE daily_hour`，建空表同样是毫秒级）。

### 升级到 v4 / v5 后要跑一次回填

`npm run backfill` 一次性回填两样东西：`last_at`（「上次实质使用」，v4）与 `daily_hour`（使用时段分布，v5）。要点：

- **与增量互不依赖**：不跑也不影响新数据——ingest 从升级那一刻起就正常写 `last_at`，只是历史行留空、看板显示「—」。所以这一步**可延后、可中止、可重跑**。
- **不塞进迁移是刻意的**：迁移随进程启动跑且整段在一个事务里，回填要扫全量 `events`（生产可达 700 万行），塞进去会把启动阻塞到 systemd 的 `TimeoutStartSec`。
- **可在线跑**：按天分事务（一天约几千行写），锁持有百毫秒级，与 ingest 争锁由 `busy_timeout=5000` 兜底；真被卡住也不丢数据（客户端 fail-open + spool 补发）。停服跑最干净但非必须。
- **幂等**：逐日「从 events 重算后覆盖」，跑两遍结果逐位相同，中断后直接重跑。
- **覆盖范围**：`events` 保留窗内（默认 90 天）精确到秒；更早的只能用当日 `day` 兜底成**日精度**（`12:00Z` 占位，在 ±12 时区内都仍属同一本地日）。
- **收尾会报「仍为空 N 行」，这不是失败**：纯心跳日的 `daily_user` 行本就没有实质使用，`last_at` 为空是正确语义（=「装了但当天没用」）。
- **时段分布（v5）没有日精度兜底**：小时信息只存在于 `events.client_ts` 里，`events` 一过保留期就**物理不可重建**——比 `events` 更早的日子永远没有作息数据，看板会标注实到起始日。这与 `last_at` 不同（后者还能用当日 `day` 兜底成日精度）。
- **改过 TZ 就不能只补跑增量**：时段回填按运行时 TZ 现算，与之前增量积累的行会对不上。见 §4.1。

## 6. 日志

服务**不写日志文件**，全部通过 `console.log('[tag]', ...)` 打到 **stdout**：

| tag | 含义 |
|-----|------|
| `[server]` | 启动监听、错误兜底(状态码+消息)、优雅退出 |
| `[db]` | schema 迁移 |
| `[ingest]` | 上报接口内部异常 |
| `[stats]` | 查询接口内部异常 |
| `[export]` | CSV 导出内部异常 / 命中 10 万行上限的截断提示 |
| `[auth]` | 预置管理员、默认密码告警 |
| `[aggregate]` | 夜间 job 成功摘要 / 失败原因 |
| `[update]` | 查版(带客户端自报版本) / 下载(含 404 具体原因) / 发布·下架审计 / `index.json` 读取失败 |

- systemd 下由 journald 捕获：`journalctl -u cancong-ops -f`(实时) / `journalctl -u cancong-ops --since today`。
- 排查自动更新：`journalctl -u cancong-ops | grep '\[update\]'`。`latest current=<x> → 200 <y>` 里
  **x 长期不前进而 y 一直更高**，即客户端装完版本没变——发布时版本号标错（对照同版本的
  `publish` 审计行，它记着上传包的原始文件名，名里嵌着包的真实版本）。
- 如需落文件，在单元 `[Service]` 加 `StandardOutput=append:/var/log/cancong-ops.log`(默认未配)。

## 7. 健康检查与自测

```bash
# 探活
curl http://localhost:5900/healthz              # → {"ok":true}

# 灌演示数据(仅测试环境)
node scripts/seed-demo.js --db /var/lib/cancong-ops/ops.db

# 查询
curl "http://localhost:5900/v1/stats/overview"
curl "http://localhost:5900/v1/installs"

# 看板
#   浏览器打开 http://<host>:5900
```

监控探针建议打 `/healthz`(200 即存活)；业务活性可看 `/v1/stats/overview` 的 `onlineInstalls` 是否合理。

## 8. 夜间聚合 job

进程内调度，**本地凌晨 3:00** 触发一次：核对补算最近 3 天聚合 → 90 天清理 events → 清理 7 天外 hb_seen → `incremental_vacuum` + WAL checkpoint → `PRAGMA optimize`。

- **错过自动补跑**：进程重启后若 `last_job_day != 今日`，30 秒后补跑一次(job 幂等，多跑无害)。
- **失败自动重试**：job 内部异常时**不推进** `last_job_day`，下次启动补跑与次日定时都会重试；失败原因记入 `meta.last_job_result`。
- 查看上次执行：`sqlite3 ops.db "SELECT key,value FROM meta WHERE key LIKE 'last_job%'"`。

## 8.1 共部署自进化服务（cancong-evolve）

蓝图自进化中心（补丁簇 / 队列 / 篮子推送 / 留出对照）2026-11 拆成独立服务 **cancong-evolve**（独立仓 EvolveServer，
部署见该仓 `docs/DEPLOYMENT.md`；设计 TechDemos `docs/EVOLVE-SERVICE-SPLIT-DESIGN.md`）。中心机的形态：

- 同一台机器：本服务 `:5900` + cancong-evolve `:5901` + 蚕丛独立版 `:5599`（`--env BP_EVOLVE=0`）。**登录各管各的**：cancong-evolve 用自己的账号或工号登录，不借用本服务的登录（原先的 `EVOLVE_AUTH=ops` 2026-11-19 去掉）。
- 本服务单元设 `Environment=OPS_EVOLVE=:5901`（`deploy/cancong-ops.service` 已带）：`GET /v1/discovery` 据此告诉客户端「自进化在同主机 5901」，
  看板「自进化」「需求研发」页签据此给出打开那个网站的链接（不嵌它的页面）。不设 ⇒ 页签隐藏、客户端不往这里推自进化样本。
- 「框架问题」仍归本服务（顶层页签，含「已修复于 vX / 回归」）。
- 升级前备份库。从借用登录的老版本升上来时两边一起升：老看板的页签会一直提示「不认这个会话」。

### 8.2 从带自进化中心的旧版本升级（schema v6 → v7）

v7 迁移删掉五张自进化表（`evolve_samples/clusters/batches/holdout/audit`）与 meta 键 `evolve_config`，保留 `fw_issues`
并把机器数回填进新表 `fw_issue_machines`。**迁移只进不退**：升级前按 §9 备份 `ops.db`；回退 = 还原备份 + 回退代码
（单纯回退代码时 v6 迁移不会重跑，旧代码启动即因表缺失报错）。自进化旧数据不迁移（拆分时现网未上线自进化）。

## 9. 备份

WAL 模式下**不要只拷 `.db` 主文件**(`-wal` 里可能有未 checkpoint 的数据)。用以下任一：

```bash
# 在线一致性快照（推荐，服务运行中可执行）
sqlite3 /var/lib/cancong-ops/ops.db "VACUUM INTO '/backup/ops-$(date +%Y%m%d).db'"

# 或停服后整套拷贝
systemctl stop cancong-ops
cp /var/lib/cancong-ops/ops.db* /backup/
systemctl start cancong-ops
```

库体积预期：千人级 × 90 天约 3–5 GB(`incremental_vacuum` 控制)。

### 9.1 应用更新发布区(`releases/`)

安装包**不进 SQLite、不进 git**，独立落在 `OPS_RELEASES_DIR`(缺省 `WorkingDirectory/releases`)：

```
releases/
├── index.json                发布清单单一真源 { published, history }；救急可直接 cat / 手改
├── staging/<ver>/            草稿区：<variant>.exe + 同名 .json 边车（中间态，可重传）
└── published/<ver>/          已发布包，保留最近 3 个版本供回滚
```

- **磁盘**：两变体约 115MB + 273MB ≈ 370MB/版本 × 3 版本 ≈ **1.2GB**，加上草稿区峰值再留一版余量。部署盘不够就把 `OPS_RELEASES_DIR` 指到数据盘。
- **权限**：`User=ops` 需对该目录可写（服务自建子目录）。首次推包报 500 `stage failed` 基本都是这里。
- **备份**：只需 `index.json` + `published/`（staging 是中间态）。包本体在构建机 / GitHub Release 另有一份，丢了重传再发布即可。
- **上传是分钟级长请求**：进程已在 `listen` 后关掉 `srv.requestTimeout`（保留 `headersTimeout=60s`）。**若前面挂了 nginx 等反向代理，必须同步放宽**，否则 273MB 的包会在代理层被截断：

```nginx
client_max_body_size 1g;
proxy_request_buffering off;   # 别把整包缓冲到代理磁盘再转发
proxy_read_timeout 1800s;
proxy_send_timeout 1800s;
```

- **下架回滚**看板一键完成（删当前版本文件 → 回退到上一个文件仍在的已发布版本；没有则清空，客户端查版回 204）。极端情况下直接编辑 `index.json` 的 `published` 字段亦可，服务无缓存、下次请求即生效。

## 10. 故障排查

| 现象 | 排查 |
|------|------|
| 启动即退出 | 看 `journalctl` 首行；常见为 `OPS_DB_PATH` 目录无写权限、端口被占 |
| `better-sqlite3` 加载失败 | musl/无网环境需装 `build-essential python3` 后 `npm rebuild better-sqlite3` |
| 聚合数字与实际对不上 | 检查 `TZ` 是否为 Asia/Shanghai；查 `meta.last_job_result` 是否 ok |
| 上报返回 400 `bad batch` | 批 >500 条或 body 非 `{events:[...]}` 数组 |
| 查询返回 400 `bad range` | `from/to` 非 `YYYY-MM-DD`、倒置或跨度 >400 天 |
| 库体积持续增长 | 确认夜间 job 在跑(`last_job_day`)；必要时手动 `PRAGMA incremental_vacuum` |
| 看板看不到「版本发布」页签 | 该页签只对 `role=admin` 显示；普通用户即使拿到 URL，推包/发布也会被服务端 `requireAdmin` 挡成 403 |
| 推包返回 500 `stage failed` | `OPS_RELEASES_DIR` 对服务用户不可写，或盘满(见 §9.1) |
| 推包返回 400 `upload aborted` | 请求在传输途中被掐断：查反向代理的 `client_max_body_size` / `proxy_read_timeout`(见 §9.1)；本进程侧已关掉 `requestTimeout` |
| 推包返回 400 `empty body` | 用 curl 复现时误带了 `-H 'content-type: application/json'`——`express.json` 会先吃掉 body。用 `--data-binary @pkg.exe` 且不设该头(或设 `application/octet-stream`) |
| 发布被拒「草稿区缺 X 变体」 | 两个变体没落进同一个 `staging/<版本>/`(常见于中途改了版本号)。看板「草稿区总览」能看到实际落盘情况，删掉错版本重传 |
| 客户端查版恒 204 | `index.json` 的 `published` 为 `null`——尚未发布，或刚被下架且无可回滚版本 |

## 11. PostgreSQL 迁移触发条件(预留，非 v1 工作)

实例数 > 5000、需多节点 HA、或库 > 20 GB 时考虑迁移。所有 SQL 收敛在 `lib/db.js` 单文件 DAO，SQL 方言保持 ANSI 化，迁移只动此层。
