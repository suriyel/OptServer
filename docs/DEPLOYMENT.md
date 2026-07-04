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
| `TZ` | 系统时区 | **必须钉死为 `Asia/Shanghai`**，见下 |

## 4. 时区(重要)

`day` 归日在 ingest 写入时按**进程本地时区**固化为列，此后聚合、清理、查询只认该列。

- 部署机**必须**在 systemd 单元里钉死 `Environment=TZ=Asia/Shanghai`。
- **上线后不要改 TZ**，否则新旧数据的日界口径不一致，历史聚合会漂移。
- Windows 开发机本身是 +8，天然一致。

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

## 6. 日志

服务**不写日志文件**，全部通过 `console.log('[tag]', ...)` 打到 **stdout**：

| tag | 含义 |
|-----|------|
| `[server]` | 启动监听、错误兜底(状态码+消息)、优雅退出 |
| `[db]` | schema 迁移 |
| `[ingest]` | 上报接口内部异常 |
| `[stats]` | 查询接口内部异常 |
| `[aggregate]` | 夜间 job 成功摘要 / 失败原因 |

- systemd 下由 journald 捕获：`journalctl -u cancong-ops -f`(实时) / `journalctl -u cancong-ops --since today`。
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

## 10. 故障排查

| 现象 | 排查 |
|------|------|
| 启动即退出 | 看 `journalctl` 首行；常见为 `OPS_DB_PATH` 目录无写权限、端口被占 |
| `better-sqlite3` 加载失败 | musl/无网环境需装 `build-essential python3` 后 `npm rebuild better-sqlite3` |
| 聚合数字与实际对不上 | 检查 `TZ` 是否为 Asia/Shanghai；查 `meta.last_job_result` 是否 ok |
| 上报返回 400 `bad batch` | 批 >500 条或 body 非 `{events:[...]}` 数组 |
| 查询返回 400 `bad range` | `from/to` 非 `YYYY-MM-DD`、倒置或跨度 >400 天 |
| 库体积持续增长 | 确认夜间 job 在跑(`last_job_day`)；必要时手动 `PRAGMA incremental_vacuum` |

## 11. PostgreSQL 迁移触发条件(预留，非 v1 工作)

实例数 > 5000、需多节点 HA、或库 > 20 GB 时考虑迁移。所有 SQL 收敛在 `lib/db.js` 单文件 DAO，SQL 方言保持 ANSI 化，迁移只动此层。
