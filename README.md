# cancong-ops

蚕丛 harness 的运营统计服务器：接收各实例上报的使用事件（`POST /v1/events`），SQLite 存储 + 增量聚合，提供查询聚合 API（`GET /v1/stats/*`）与自建看板（概览/趋势/工作流/用户/失败/实例/版本发布 七页）。兼任客户端的**应用自动更新发布面**（`/v1/update/*`：管理员推包发版，客户端免鉴权查版下载）。

契约与设计依据：[OPS-TELEMETRY-DESIGN.md](./OPS-TELEMETRY-DESIGN.md)——§4 事件信封（双端唯一契约）、§7.3 查询 API（看板唯一契约）。

技术形态：Node CJS 单进程，仅 2 个运行时依赖（express + better-sqlite3），零构建（看板为 vanilla ESM + vendored ECharts），数据即单个 `.db` 文件。

**文档**：[docs/](./docs/) — [API 契约](./docs/API.md) · [架构与实现](./docs/ARCHITECTURE.md) · [部署与运维](./docs/DEPLOYMENT.md) · [Release Notes](./docs/RELEASE-NOTES.md)

## 快速开始

```bash
npm ci
npm start                 # 默认 http://localhost:5900
```

浏览器打开 `http://localhost:5900`，未登录会跳到登录页。**首次启动的默认管理员账号：**

| 用户名 | 密码 |
|--------|------|
| `admin` | `admin123`（或你通过 `OPS_ADMIN_PASSWORD` 指定的初始密码） |

> ⚠️ 默认密码仅供首次登录，请尽快在看板「用户菜单 → 修改密码」改掉，或启动前用 `OPS_ADMIN_PASSWORD` 指定。登录后管理员可在「账号管理」新增普通用户；**管理员始终只有一个**。详见 [登录鉴权](#登录鉴权)。

打一批样例事件（上报接口 `POST /v1/events` **开放，无需登录**——采集端直接上报）：

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

## 环境变量

| 变量 | 默认 | 说明 |
|------|------|------|
| `PORT` | `5900` | 监听端口 |
| `OPS_DB_PATH` | `./data/ops.db` | SQLite 路径（目录自动创建） |
| `OPS_RETENTION_DAYS` | `90` | events 原始表保留天数（daily 聚合表永久） |
| `OPS_ADMIN_USER` | `admin` | 预置管理员用户名（仅首次库中无 admin 时生效） |
| `OPS_ADMIN_PASSWORD` | `admin123` | 预置管理员初始密码；用默认值时启动打印告警，请尽快改 |
| `OPS_SESSION_DAYS` | `7` | 登录会话有效期天数 |
| `OPS_SECURE_COOKIE` | 关 | 设为 `1` 时会话 Cookie 带 `Secure`（HTTPS 部署用） |
| `OPS_RELEASES_DIR` | `./releases` | 应用更新发布区目录（磁盘规划见下，约 1.2GB） |

## 时区（重要）

`day` 归日在 ingest 写入时按**进程本地时区**固化为列，此后聚合、清理、查询只认该列。部署机必须钉死时区（systemd 单元里 `Environment=TZ=Asia/Shanghai`）；**上线后不要改 TZ**，否则新旧数据的日界口径不一致。

## 数据与运维

- **存储**：`installs`（实例注册，心跳只 upsert 此表）、`events`（原始事件，滚动保留）、`daily_user` / `daily_tool` / `daily_fail`（日聚合，永久）、`hb_seen`（心跳幂等，7 天）、`meta`（job 记账）。SQL 全部收敛在 `lib/db.js`（PostgreSQL 迁移只动此文件；触发条件见设计文档 §8.4：实例 >5000 / 需 HA / 库 >20GB）。
- **看板查询走聚合、明细走 events**：DAU/会话/工具/失败分布等全部预聚合到 `daily_*` 小表，读时零扫描 events；只有「最近失败列表」读原始 events。events 上不设 `(type, server_ts)` 索引（无查询按 `server_ts` 过滤），改为 `day` 先导索引 + 两个 partial 覆盖索引（失败率分母、最近失败列表）。这套设计由 `npm run bench` 在 700 万行上验证：全部查询毫秒级（失败按版本从朴素实现的 23 秒降到个位数毫秒）。`daily_fail(day, app_version, kind)` 专为 kinds 分布而设——直接对 events 做 `json_extract(kind)` 跨天分组要走临时 B 树（30 天约 1 秒），预聚合成小表后亚毫秒。
- **夜间 job**（进程内，本地 3:00，错过自动补跑）：最近 3 天聚合核对补算（heartbeats 列除外——心跳不落 events，不可重算）→ 90 天清理 → `incremental_vacuum` + WAL checkpoint。
- **备份**：在线执行 `sqlite3 ops.db "VACUUM INTO '/backup/ops-YYYYMMDD.db'"`，或停服后拷全套文件。**WAL 模式下不要只拷 `.db` 主文件**（`-wal` 里可能有未 checkpoint 的数据）。
- **应用更新发布区**（`releases/`，`OPS_RELEASES_DIR` 可改）：`staging/`（草稿）+ `published/`（保留最近 3 个版本，约 3 × 370MB ≈ **1.2GB**，部署盘要留出）+ `index.json`（发布清单单一真源，救急可直接 `cat`/手改）。备份只需 `index.json` + `published/`（staging 是中间态、可重传）；包文件本体在 GitHub Release / 构建机各有一份，丢了可重传再发布。
- **部署**（内网 Linux）：`npm ci --omit=dev`（better-sqlite3 有 linux-x64 glibc 预编译；musl/无网环境需 `build-essential + python3` 兜底编译）→ `deploy/cancong-ops.service` 装入 systemd。

## 开发

```bash
npm test                  # node:test 确定性测试（无外网、无浏览器）
npm run bench             # 700 万行压测：灌数 → 全量重算 → 逐查询 p50/p95 对照验收线
npm run migrate -- --db <path>   # 对已有库单独跑 schema 迁移（不启动服务；幂等）
npm run vendor            # 升级 echarts/字体后重拷 public/vendor/（vendored 产物提交进 git）
```

目录：`lib/`（`db` 唯一 SQL 层 / `ingest` / `stats` / `export` + `csv` / `auth` / `update` / `aggregate` / `time-utils`）、`public/`（看板：js/core + js/features 分层）、`__tests__/`、`scripts/`、`deploy/`。

## API 速览

```
POST /v1/auth/login        # { username, password } → 下发 ops_session Cookie + 返回 { token, role }
POST /v1/auth/logout       # 注销当前会话
GET  /v1/auth/me           # 当前登录者 { username, role }
POST /v1/auth/password     # 改本人口令 { oldPassword, newPassword }
GET  /v1/auth/users        # 列出账号（管理员）
POST /v1/auth/users        # 新增普通用户 { username, password }（管理员；role 恒 user）
DELETE /v1/auth/users/:username  # 删除用户（管理员；不可删 admin）
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
GET  /v1/export/{blueprints,users,failures,installs}?from&to  # CSV 导出（中文表头 + UTF-8 BOM）

# 应用自动更新（详见 docs/API.md）
GET  /v1/update/latest             # 查版：manifest 或 204（免鉴权）
GET  /v1/update/download/:file     # 下载安装包，支持 Range 断点续传（免鉴权）
POST /v1/update/upload?variant&version[&filename]   # raw octet-stream 推包（管理员）
GET  /v1/update/drafts             # 草稿区 + 当前已发布 + 可回滚历史（登录即可读）
POST /v1/update/publish            # { version, notes, minSupported } 服务端自检后发布（管理员）
POST /v1/update/unpublish          # 下架当前版本并回滚到上一版（管理员）
DELETE /v1/update/draft/:version/:variant           # 删草稿（管理员）
```

## 登录鉴权

简单登录模式：**预置一个管理员**（`OPS_ADMIN_USER`/`OPS_ADMIN_PASSWORD`，首次启动自动创建），管理员可在看板「账号管理」新增普通用户；**管理员永远只有一个**（应用层新增用户恒 `role=user`，库层 `accounts` 上的 partial unique index 兜底，任何路径都造不出第二个 admin）。

- **保护范围**：**只保护 web 看板**——看板页面与查询/账号接口（`/v1/stats/*`、`/v1/export/*`、`/v1/auth/users*` 等）都要求登录会话；未登录访问页面 → 302 跳 `/login.html`，访问受保护 `/v1` → 401。**采集端上报 `POST /v1/events` 完全开放、无需鉴权**（内网即信任，cancong 客户端不带任何凭据，接入无需改动）。白名单还含 `/healthz`、`/login.html`、`POST /v1/auth/login`。全局门禁在 `server.js` 一处（`createAuthGate`），逻辑集中在 `lib/auth.js`。
- **会话**：浏览器登录后用 `ops_session` Cookie（`HttpOnly`）访问看板；脚本化访问受保护接口时可选用 `Authorization: Bearer <token>`（token 来自 `/v1/auth/login` 返回体）。口令用内置 `crypto` scrypt 哈希，无第三方依赖。

## 应用自动更新发布

看板「版本发布」页（**仅管理员可见**，服务端 `requireAdmin` 才是真正把关）一页走完发版：

1. **先填版本号**（三段数字，如 `0.0.4`）——它决定包落进 `staging/<版本>/`，是上传的前置条件。没填就选包时，出问题的那一行会红字提示、版本框高亮；**已选的文件会留着**，补好版本号直接点该行的「上传」即可，不必重选。
2. **两个变体各选包上传**（`slim` / `with-linux`）。服务端边写边算 sha256 落草稿区，同 (版本, 变体) 重传直接覆盖（幂等）。首次上传后版本号锁定，要换版本点「换版本」——防两个变体落进不同版本目录。
3. **两包齐备后「发布」解禁**。服务端自检：两变体齐备 + 版本号三段数字且高于当前已发布 + 大小/sha256 复算与上传记录一致 + 版本地板为空或合法且不高于发布版本。任一不过原样回错误文案，包留在草稿区可重传。
4. **下架/回滚**：删当前版本文件并回退到上一个文件仍在的已发布版本；没有则清空（客户端查版回 204，不提示更新）。发布区保留最近 **3** 个版本供回滚。
5. **草稿区总览**列出服务器上全部草稿及各变体就位情况，传错版本号可就地删除。

> **版本地板**（`minSupported`）留空 = 不阻断。填了则低于此版本的客户端被阻断强制升级——这是唯一的召回手段，慎用。

客户端侧免鉴权：`GET /v1/update/latest` 查版、`GET /v1/update/download/:file` 下载（支持 `Range` 断点续传）。客户端只认 manifest 里的 `packages[variant].file`，绝不自己拼文件名。升级终局由客户端上报 `update_apply` 事件，装失败以 `kind=update:<reason>` 进入失败页分布与最近失败列表（CSV 导出同口径）。
