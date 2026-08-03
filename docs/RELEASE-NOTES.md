# Release Notes

本文件记录 cancong-ops 各版本的变更。遵循「面向使用者的价值 + 面向维护者的关键实现」双视角。

---

## 未发布

### 修复

- **版本发布页：「发布」按钮无解释地点不动，以及上传成功的包又显示「未上传」**。两个现象同一个根因——**行内状态与「发布」闸门只认版本输入框里那一个版本，而服务端草稿区是按版本分桶的多份状态**；两者一分叉，已传成功的包就在行内凭空消失。「未上传」的真实含义是"当前填的这个版本号下没有这个包"，字面却读作"你根本没传上去"，所以极难自查。分叉有三个入口，都已堵上：
  - **补填版本号不补跑上传**：版本框空着选包时走 `needVersion()` 早退，文件只进 `picked`；随后补填版本号的 `input` 监听器只清提示、**不补跑上传**。而第二个包因版本号已就位自动传了——先选包的变体永远停在「已选待传」，用户以为两个都传了，「发布」却一直灰着。现在版本号**落定时**（`change`，失焦/回车）自动补跑被搁置的上传。挂 `change` 不挂 `input` 是硬要求：逐字输入 `0.4.10` 会在打到 `0.4.1` 时抢跑上传，而 `verLocked` 会把版本号锁死在那个错版本上。文件名版本对不上的（带 `rowErr`）刻意不补传，仍需人工确认后点「上传」。
  - **换版本 / 静默预填让输入框版本与实际上传版本分叉**：`refresh()` 会在版本框为空时静默填入草稿区最新版本，用户当成自己填的；「换版本」又只清本地已选文件、对服务端已传的包只字不提。现在包在别的版本里会**直接点破**（`⚠ 版本 X 下没有此包——它在草稿 Y 里`），预填也会在闸门行说明来源，「换版本」明说服务端的包不受影响。
  - **并发刷新用旧快照覆盖**：`refresh()` 原先没有代际守卫，`data` 由最后落地的响应决定。上传是分钟级长请求，期间 60s 轮询与 `visibilitychange`（等待时切走再切回）必然并发；一个「上传完成前发出、完成后落地」的旧快照会把刚传好的变体抹掉——读条走完、传成功，界面却回到「未上传」。现在 `refresh()` 只认最后一次发起的响应，上传成功还会用**服务端回执就地渲染**，不再把成功态押在随后那次 GET 上。
- **「发布」禁用时不给理由**：按钮禁用态只有 `opacity: .45`，旁边一片空白，用户无从判断是"包没传上去"还是"页面坏了"。新增 `#rel-gate` 专放闸门原因（差哪个变体、文件已选好待点「上传」、包在别的草稿里、有变体正在上传、草稿区加载失败），与放操作结果的 `#rel-msg` 分开，互不覆盖。
- **待办态与完成态、空态同色**：`.rel-status` 三种语义共用 `--muted` 灰字，「已选待传」和「未上传」「✓ 已上传」看着一模一样，正是上面两个故障看不出来的直接原因。待办态改用 amber 信号色（`.rel-todo`），同一行的「上传」按钮跟着高亮。

### 验证

101 个 `node:test` 用例全绿（本次不动 `lib/`，服务端零回归）。发布面经 Playwright 端到端实测：先复现两个故障（network log 佐证「slim 从未发出上传请求」、`staging/0.4.1/with-linux.exe` 确实在盘上而界面显示「未上传」），打补丁后同一时序全部通过；代际守卫用 `fetch` 打桩做了 A/B 对照——关掉守卫时刚传成功的变体被延迟落地的旧快照打回「未上传」，开启后保持 `✓`。回归覆盖：文件名版本不符不自动补传、逐字输入 `0.4.10` 不抢跑、删草稿、下架回滚、「填入版本」、页签切走再切回。

---

## v0.4.0 — 2026-08-02

登录鉴权 + CSV 导出 + 应用自动更新发布面。看板从「只读统计」扩成「带账号的运维台」，并接管客户端的版本分发。

### 新增能力

**登录鉴权（只保护看板）**
- 首次启动**预置一个管理员**（`OPS_ADMIN_USER`/`OPS_ADMIN_PASSWORD`，默认 `admin`/`admin123`，用默认密码时启动打印告警）；管理员可在「账号管理」新增普通用户，**管理员永远只有一个**（应用层新增用户恒 `role=user`，库层 `accounts` 上的 partial unique index 兜底）。
- 浏览器走 `ops_session` Cookie（`HttpOnly`），脚本走 `Authorization: Bearer`。口令用内置 `crypto` scrypt 哈希 + `timingSafeEqual`，**零新增依赖**。
- **保护范围只到看板**：`POST /v1/events` 采集上报完全开放（内网即信任，客户端不带凭据，接入无需改动）；`GET /v1/update/latest` 与 `/v1/update/download/*` 同档开放。其余页面与 `/v1` 需登录，未登录页面 → 302 `login.html`、`/v1` → 401。

**CSV 导出**
- 工作流/用户/失败/实例四页各加「导出 CSV」按钮，按当前日期范围下载。中文表头 + UTF-8 BOM（Excel 双击不乱码），数值列导原始整数。
- 导出突破看板展示上限：用户导全量全指标、失败导明细（不再是最近 100 条）、实例导全部。新端点 `GET /v1/export/{blueprints,users,failures,installs}` 复用现有 DAO，不改动既有查询/聚合/ingest。

**应用自动更新发布面**
- 新增「版本发布」页（仅管理员可见）：上传 `slim`/`with-linux` 两变体安装包 → 服务端复算 sha256 与大小、校验版本递增 → 发布；支持一键下架回滚，发布区保留最近 3 个版本（约 1.2GB，见 [DEPLOYMENT.md §9.1](./DEPLOYMENT.md)）。
- 客户端**免鉴权**访问 `GET /v1/update/latest` 查版、`GET /v1/update/download/:file` 下载（`res.sendFile` 原生支持 `Range` → 断点续传白拿）。尚无已发布版本返 **204**（不是 404，避免与路由错误混淆）。
- **版本地板**（`minSupported`）：留空 = 不阻断；填了则低于此版本的客户端被阻断强制升级——唯一召回手段。
- 客户端上报的 `update_apply` 接入聚合：装失败以 `kind=update:<reason>` 进入失败页 kind 分布与最近失败列表，CSV 导出同口径。

**采集端联调**
- 新增 [CLIENT-HANDOFF.md](./CLIENT-HANDOFF.md)：面向蚕丛 harness 的 server-telemetry 开发者，一次讲清传输契约、7 类事件 payload、三处需新采集的数据来源（token/interruptions/blueprintId）、客户端模块挂接点、三层开关与可靠性设计、端到端联调步骤与验收清单。

### 关键实现

- **发布面存储不进 SQLite**：`releases/index.json`（`{published, history}`，tmp+rename 原子写）+ `staging/<ver>/` 草稿 + `published/<ver>/` 已发布。与遥测库解耦，出事时运维可直接 `cat`/手改救急；包本体在构建机另有一份，丢了可重传再发布。
- **上传是 raw octet-stream 边写边算 sha256**，**不引入 multer/multipart**——`express.json` 只拦 `application/json`，不会吃掉它的 body；浏览器侧 `xhr.send(file)` 流式发送并报进度。同 (版本, 变体) 重传直接覆盖（幂等）。发布时 staging → published 同卷 `rename`，文件名归一为无空格 slug。
- **schema 迁移 v3**：新增 partial 索引 `ix_update_recent ON events(day, server_ts) WHERE type='update_apply'`（只加索引，不加表）。已有库可用 `npm run migrate -- --db <path>` 停服单独迁移，脚本不复制 DDL、直接调 `openDb()`，不会与 `MIGRATIONS` 漂移。
- **最近失败列表改写为 `UNION ALL`**：列表要同时列出 `failure_event` 与 `update_apply{ok:false}`，但一条带 `OR` 的谓词会让两个 partial 索引**同时**失效（SQLite 退化成扫全窗口 + TEMP B-TREE 排序，bench 的 20ms 验收线会破）。拆成两个各带 `LIMIT` 的子查询后各走各的索引，外层只归并 ≤2×limit 行。
- **上传是分钟级长请求**：`listen` 后关掉 `srv.requestTimeout`（Node 18+ 默认 300s 会把 ~370MB 的包截断成 `400 upload aborted`），保留 `headersTimeout=60s`。反向代理需同步放宽。

### 修复

- **版本发布页选完包没有任何上传入口，发布又被拒「草稿区缺变体」**。根因是上传被做成 file input `change` 事件的隐式副作用：版本号未填时静默早退，而 `input.value` 未清空 → 重选同一文件不再触发 `change` → 没有上传按钮可退守，用户彻底卡死，包永远进不了草稿区。改为**每个变体行配独立「上传」按钮**（版本号已合法时仍自动发起，按钮始终可用于重试）、版本号缺失的提示落在出问题的那一行并保留已选文件名、首次上传后锁死版本号（防两变体落进不同 `staging/<ver>/`）、新增「草稿区总览」列出服务器实际落盘情况并接上早已实现却没有 UI 入口的删草稿端点。
- **「发布」按钮初始可点**：`#rel-publish` 初始 HTML 缺 `disabled` 且 `init()` 不调 `renderDraftStatus()`，草稿列表没回来（或 `refresh()` 抛错）时按钮一直可点，点下去服务端回「草稿区缺 X 变体」，被误读成包传丢了。现在初始即禁用，`refresh()` 的 catch 分支也强制置灰。
- **失败 CSV 与看板口径对齐**：导出侧补上 `update_apply{ok:false}` 的列映射（来源 `auto-update`、类型 `update:<reason>`、原因为版本迁移描述），与看板「最近失败」表一致，同一批数据两处不再对不上。

### 验证

96 个 `node:test` 用例（新增 `auth` 口令/会话/门禁白名单/单一 admin、`export` CSV 列/BOM/注入防护、`update` 上传幂等/发布自检/Range 下载/下架回滚/路径穿越/ingest 聚合）。发布面另经 Playwright 端到端实测：不填版本号选包 → 行内报错且文件保留 → 补版本号点「上传」（不重选文件）→ 两包齐备 → 发布 → `/v1/update/latest` 返回完整 manifest、下载字节 sha256 与源文件一致、`Range` 回 206 → 下架回 204；并注入 `fetch` 失败验证加载异常时「发布」保持置灰。

---

## v0.3.0 — 2026-07-04

趋势页统一 ECharts + 新增实时视图。

### 新增能力
- **趋势页「实时」视图**：顶部「按日期 / 实时」模式切换。实时 = 近 24 小时、1 分钟分桶，展示事件脉冲(面积)、run 终态(堆叠)、活跃人数+会话数、Token 消耗四图，每 60s 刷新拉新分钟桶，支持 dataZoom 缩放/滚动。
- 新端点 `GET /v1/stats/realtime?window=`：按分钟直查 events，无新增存储；只返回非空桶，前端补零完整分钟轴。

### 关键实现
- **图表库统一为 ECharts**：趋势页从 uPlot 迁到 ECharts(`core/echarts.js` 新增 `timeLine`/`timeBars` 时序构建器)，**整体移除 uPlot**(vendored 文件、`core/charts.js`、devDep)——看板收敛到单一图表库。
- 实时直查 events：`day` 先导索引缩到近 ~2 天，再按 `server_ts` 精确切窗，700 万行实测毫秒级(<200ms)。token 口径与 daily 一致(仅 session_end，防双计)；`activeUsers` = 每分钟去重 user@host(活跃≠在线，心跳不落 events)。

### 验证
65 个 `node:test` 用例(新增 realtime 分桶/窗口切分/activeUsers 去重)；`npm run bench` 700 万行 realtime 近 24h 查询过验收线；Playwright 实测两模式渲染与切换。

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
