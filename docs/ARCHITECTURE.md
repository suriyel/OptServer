# cancong-ops 架构与实现

> 面向维护者。讲清模块划分、存储 schema、索引设计、三个易错点的解法，以及数据生命周期。
> 契约层面见 [API.md](./API.md)，部署运维见 [DEPLOYMENT.md](./DEPLOYMENT.md)。

## 1. 形态与依赖哲学

- **单进程 Node CJS**(无 `type` 字段)，仅 2 个运行时依赖：`express` + `better-sqlite3`。
- **零构建**：看板是 vanilla ESM + vendored 前端库（ECharts / IBM Plex Mono），源码即产物。图表库统一为 ECharts。
- **数据即单个 `.db` 文件**：备份 = 拷文件，PostgreSQL 迁移只动 `lib/db.js` 一层。
- 与主仓库(蚕丛 harness / TechDemos)同栈同哲学，便于对照维护。

## 2. 模块划分

```
server.js            入口：Express 装配 + 生命周期（createApp / gracefulShutdown）
lib/
  db.js              唯一 SQL 层：连接/PRAGMA/迁移/全部 prepared DAO（PG 迁移只动此文件）
  ingest.js          POST /v1/events：校验 + 单事务批插 + 幂等聚合
  stats.js           GET /v1/stats/* + /v1/installs：查询聚合
  export.js          GET /v1/export/*：CSV 导出（列定义 + payload 拍平），序列化走 csv.js
  csv.js             CSV 序列化（中文表头 + UTF-8 BOM + 注入防护）
  auth.js            scrypt 口令 + 会话令牌 + 全局门禁 createAuthGate + requireAdmin + 账号路由
  update.js          /v1/update/*：应用自动更新发布面（文件系统存储，不落 SQLite）
  aggregate.js       夜间 job：核对补算 + 滚动清理 + 空间回收 + 进程内调度
  time-utils.js      localDay（day 归日）+ shiftDay（日历运算）
public/              看板：index.html + login.html + js/{core,features} + css + vendor/{echarts,fonts}（七页）
scripts/             bench.js（压测）/ seed-demo.js（灌演示数据）/ migrate.js（对已有库单独迁移）/ vendor-assets.js（拷 vendored 前端库）
deploy/              cancong-ops.service（systemd 单元）
__tests__/           node:test 确定性测试（96 用例）
releases/            应用更新发布区（运行时生成，OPS_RELEASES_DIR 可改；不进 git）
```

**装配顺序**(`server.js::createApp`)：`express.json(1mb)` → `/healthz` → 全局门禁 `createAuthGate`(只保护看板：未登录页面→302 `login.html`、受保护 `/v1`→401；白名单 `/healthz`+`/login.html`+`POST /v1/auth/login`+**`POST /v1/events` 采集上报**+**`GET /v1/update/latest` 与 `/v1/update/download/*` 客户端查版下载**) → `/v1` auth 路由(登录/账号) → ingest / stats / export / update 路由 → `public/` 静态(仅登录后可达) → `/v1` JSON 404 → 错误兜底中间件。鉴权逻辑收敛在 `lib/auth.js`（scrypt 口令 + 会话令牌，Cookie/Bearer 双通道）；运维动作（推包/发布/下架/删草稿、账号增删）额外过 `requireAdmin`。

**上传是长请求**：`listen` 后显式 `srv.requestTimeout = 0`（保留 `headersTimeout = 60s`）。Node 18+ 默认 300s 整请求超时会把 ~370MB 的 `with-linux` 包在慢链路上截断成 `400 upload aborted`。反向代理侧需同步放宽 `client_max_body_size` / `proxy_read_timeout`。

**生命周期**：`require.main` 时才 `listen` + `startScheduler` + 注册 SIGINT/SIGTERM。优雅退出逻辑抽为 `gracefulShutdown(scheduler, srv, close, exitFn, timeoutMs)`——停调度器 → `srv.close` 收尾 → 关库退出，3s 兜底强退。测试 `require` 不触发 `listen`。

## 3. 存储 schema

10 张表(`lib/db.js`：`DDL_V1` 基础 8 张 + `DDL_V2` 鉴权 2 张)，通过 `PRAGMA user_version` 迁移(当前 **v3**——v3 只加 `ix_update_recent` 索引，不加表)。已有库可用 `npm run migrate -- --db <path>` 单独迁移，不必靠启动服务触发。

| 表 | 作用 | 保留 |
|----|------|------|
| `installs` | 实例注册表；心跳只 upsert 此表 | 永久 |
| `events` | 原始事件(session/run/failure)；带固化的 `day` 列 | 滚动 90 天 |
| `daily_user` | 用户维度日聚合(sessions/runs/failures/heartbeats/**in_tokens/out_tokens**...) | 永久 |
| `daily_tool` | 工具维度日聚合 | 永久 |
| `daily_fail` | 失败维度日聚合(day, app_version, kind) | 永久 |
| `daily_blueprint` | **工作流维度日聚合(runs/失败/active_ms/interruptions/token)** | 永久 |
| `hb_seen` | 心跳幂等去重表 | 7 天 |
| `meta` | 夜间 job 记账(last_job_day / last_job_at / last_job_result) | 永久 |
| `accounts` | 登录账号(scrypt 口令+role)；`ux_accounts_admin` partial unique 保证至多一个 admin | 永久 |
| `sessions` | 登录会话(token→username，按 `expires_at` 惰性过期) | 会话期 |

> 术语：**工作流** = 内部 `blueprint`/`blueprintId`（事件 `bp_run_*` 沿用既有契约名）。

### Token 防重复计数(关键设计)
会话含多个 run，run token 是会话 token 子集。故 token 分两处、互不重复求和：
- `session_end` token → **`daily_user.in/out_tokens`**：总量权威(概览/趋势/Top 用户)。
- `bp_run_end` token → **`daily_blueprint.in/out_tokens`**：工作流归因子集(工作流页)。

`sum(daily_blueprint.tokens) ≤ sum(daily_user.tokens)`——非 run 活动(如临时对话)不计入工作流，预期且正确。失败同理：`failure_event` 始终计入 `daily_user.failures`/`daily_fail`；仅当带 `blueprintId` 时**额外**归因到 `daily_blueprint.failures`。

**PRAGMA 时序**(敏感)：`auto_vacuum = INCREMENTAL` 只对未建表的空库生效，**必须先于 DDL**；`journal_mode = WAL`、`synchronous = NORMAL`、`busy_timeout = 5000`。

**看板查询走聚合、明细走 events**：DAU/会话/工具/失败分布全部预聚合到 `daily_*` 小表，读时零扫描 events；只有"最近失败列表"读原始 events。

## 4. 索引设计(压测驱动)

events 表**不设 `(type, server_ts)` 索引**——所有查询按 `day` 过滤而非 `server_ts`，那样的索引只会白白加重写路径。改用：

```sql
CREATE INDEX ix_events_day    ON events(day);                                    -- 清理 + 补算
CREATE INDEX ix_runend_ver    ON events(day, app_version) WHERE type='bp_run_end';    -- 失败率分母(覆盖)
CREATE INDEX ix_fail_recent   ON events(day, server_ts)  WHERE type='failure_event';  -- 最近列表(反向扫)
CREATE INDEX ix_update_recent ON events(day, server_ts)  WHERE type='update_apply';   -- v3：装失败并入最近列表
```

- `ix_runend_ver`/`ix_fail_recent`/`ix_update_recent` 是 **partial 覆盖索引**，只索引各自的 type 子集，写放大小。
- 最近失败列表用 `ORDER BY day DESC, server_ts DESC` 配合 partial 索引反向扫 + LIMIT 提前终止。
- **最近失败列表必须写成 `UNION ALL` 而非 `WHERE ... OR ...`**（`stRecentFailures`）：列表要同时列出业务失败 `failure_event` 与装失败 `update_apply{ok:false}`，但一条带 `OR` 的谓词会让两个 partial 索引**同时**失效——SQLite 弃用 `ix_fail_recent`，退化成 `ix_events_day` 扫全窗口 + TEMP B-TREE 排序，90 天窗口下每行都要回表取 `type`（EXPLAIN 实测，bench 的 `failures recent 100` 20ms 验收线会破）。拆成两个各带 `LIMIT` 的子查询后，两分支各自命中自己的索引，外层只归并 ≤2×limit 行（故 DAO 绑 7 个参数）。复合查询的外层 `ORDER BY` 只能引用输出列名，因此 `day` 必须出现在 SELECT 列表、且外层用别名 `serverTs`。
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
  ├─ 核对补算最近 3 天 daily_user/daily_tool/daily_fail/daily_blueprint（heartbeats 除外）
  ├─ 90 天滚动清理 events（分块 DELETE 避免长事务锁写路径）
  ├─ hb_seen 清理 7 天外
  ├─ PRAGMA incremental_vacuum + wal_checkpoint(TRUNCATE)
  └─ PRAGMA optimize（partial 覆盖索引选取依赖统计保鲜）
                                    │
查询 → stats / export（走 daily_* / installs，毫秒级；仅 recent 读 events）→ 看板 + CSV
```

## 7. 看板(public/)

单 `index.html` + hash tab 七页(概览/趋势/**工作流**/**用户**/失败/实例/**版本发布**)，vanilla ESM：`js/core/{api,auth,download,fmt,echarts,range,detail}.js` + `js/features/{overview,trend,blueprints,users,failures,installs,accounts,release}.js`。设计语言为「精密仪表盘」暗色(amber 信号色 + cyan 副色、IBM Plex Mono 等宽数字、载入错峰揭示)。**图表库统一为 vendored ECharts**，收口于 `core/echarts.js`(`makeChart` 实例管理 + 主题；`rankedBar`/`stackedBar` 横向、`timeLine`/`timeBars` 时序)。60s 自动刷新当前激活页，`document.hidden` 时暂停。

- **趋势页**：顶部「按日期 / 实时」模式切换(localStorage 记忆)。**按日期**沿用全局 7/30/90，x=日；**实时**近 24h/1min 分桶(`/stats/realtime` 直查 events，前端补零完整分钟轴 + 本地 HH:MM + dataZoom)。四图 = 事件脉冲(面积) / run 终态堆叠 / 活跃人数+会话 / Token。
- **工作流页**：ECharts 横向条形(主视图，指标切换：运行终态堆叠 / Token 输入输出 / 中断排名) + 明细排序表。
- **用户页**：ECharts 横向排名条形(Top 10) + 明细表；metric 分段控件(会话/run/token/时长/失败)切换即重查 `/stats/users/top?metric=`。
- **两页共有的时间维度**(设计留档见 [TIME-DIMENSION-PLAN.md](./TIME-DIMENSION-PLAN.md))：**环比列跟随当前排序列**(用户页跟随 metric)，**点行展开**详情面板 = 该实体日曲线 + 「本期 vs 上期」对比条(`core/detail.js` 提供对比条与脚注，图表实例各页自管、一次只开一行)。三条约束是踩出来的：**① 环比的两个对比窗都截至昨日**(`lib/stats.js::compareWindows`)——主表总量与曲线仍含今日(实时感)，但 range 末尾的今天只过了一半，拿它当分子会让每天上午一片飘红、下午转绿；**② 两期任一 <10 时改显绝对差**(`fmt.js::fmtDelta`)——长尾工作流 1→3 就是 `+200%`，比真正重要的 `+18%`(312→368)还刺眼；**③「当日不完整」提示挂标题行不挂图内**——ECharts `markArea` 的标签在一格 30~40px 宽的类目上必被 grid 裁掉(实测)，图内只留末点压暗 40%；**④ 两页的 `refresh()` 都带代际守卫**(`core/api.js::makeGuard`)，且守卫挡在**赋值之前**——切档位时 90 天查询比 7 天慢，落地顺序与发起顺序相反，没守卫就会出现「顶栏显示 7 天、表格渲染 90 天数据」且脚注还用权威口吻写着 90 天的对比窗(已实测复现)；触发面不止手动连点，60s 轮询与 `visibilitychange` 也会并发。详情图另需比**实例身份**(`detailChart !== inst`)而非只判 `expandedKey`——同一行换档位时 key 不变，光判 key 挡不住旧序列画进新图。
- 概览加 token 卡片、趋势加 token 消耗曲线、失败页最近失败表加「工作流」列(payload.blueprintId)且每行带 `data-event-id`(v2 一键提单入口)；最近失败表同时列出 `update_apply{ok:false}`(响应行带 `type` 区分)。
- **版本发布页**(`features/release.js`，非管理员隐藏页签)：当前已发布(+下架/回滚) | 草稿区上传两变体(XHR 报进度) | 草稿区总览(+删草稿)。五条交互约束是踩出来的，改动前先读文件头注释：**① 上传必须有独立按钮**——只挂 file input 的 `change` 会在早退后无路可走（`input.value` 没变，重选同一文件不再触发 `change`，用户彻底卡死，体感就是「没有上传按钮」）；**② 版本号缺失的提示写在出问题的那一行**并保留已选文件名，不写表单底部；**③「发布」初始即 `disabled`**，`init()` 末尾与 `refresh()` 的 catch 分支都强制置灰——drafts 没回来/加载失败时若可点，服务端会回「草稿区缺 X 变体」，被误读成包传丢了；**④ 首次上传后锁死版本号**，两个变体必须落进同一个 `staging/<ver>/`；**⑤ 行内状态与「发布」闸门只看版本输入框里那一个版本**，而服务端草稿区是**按版本分桶的多份状态**——两者一分叉，已传成功的包就在行内凭空消失、显示成「未上传」（字面读作"你根本没传上去"），「发布」跟着无解释地灰掉。所以：补填版本号必须**补跑**被搁置的上传（挂 `change` 不挂 `input`——逐字输入 `0.4.10` 会在打到 `0.4.1` 时抢跑并把版本锁死在错版本）；包在别的版本里必须**点破**而不是显示「未上传」；上传成功必须用**回执就地渲染**、`refresh()` 带**代际守卫**丢弃过期快照（分钟级上传期间 60s 轮询与 `visibilitychange` 必然并发，晚落地的旧快照会把刚传好的变体抹掉）；「发布」禁用时 `#rel-gate` 必须**说得出差什么**。

**发布面存储不进 SQLite**(`lib/update.js`)：`releases/index.json`(`{published, history}`，tmp+rename 原子写) + `staging/<ver>/<variant>.exe` + 同名 `.json` 边车(`{originalName,size,sha256,uploadedAt}`) + `published/<ver>/<归一 slug>.exe`。与遥测库解耦，出事时运维可直接 `cat`/手改 `index.json` 救急；包文件在构建机另有一份，丢了可重传再发布。上传是 raw octet-stream 边写边算 sha256（`express.json` 只拦 `application/json`，不会吃掉它的 body），**不引入 multer/multipart**，零新增依赖。发布时 staging → published 用同卷 `rename`，文件名归一为无空格 slug（规避 URL 编码问题）。

## 8. 测试

`__tests__/` 共 101 个 node:test 用例：`db`(PRAGMA/迁移/DAO) · `ingest`(幂等/心跳/day 固化/边界/fail-safe) · `stats`(端点/范围/除零/坏 payload) · `export`(CSV 列/BOM/注入防护/范围) · `auth`(口令/会话/门禁白名单/单一 admin) · `update`(上传幂等/发布自检/Range 下载/下架回滚/路径穿越/ingest 聚合) · `aggregate`(补算/清理/调度/失败重试) · `server`(装配/404/兜底)。夹具用临时 db 文件(非 `:memory:`，因 WAL 对内存库无效)。`npm run bench` 做 700 万行查询验收。

看板交互层无单测（vanilla ESM 无构建、无 DOM 测试栈），靠 Playwright 手工过关键路径——版本发布页的五条交互约束尤其要人工回归，改 `features/release.js` 后至少走一遍：**①「不填版本号选包 → 补版本号并失焦（应自动补传）→ 选第二个包 → 两包齐 → 发布 → 下架」**；**②「传完一个包 → 点『换版本』改版本号 → 已传的包必须显示『它在草稿 X 里』而不是『未上传』」**；**③ 逐字输入 `0.4.10`，打到 `0.4.1` 时不得抢跑上传**；**④ 文件名版本与填写版本不符时，失焦不得自动补传**（红字等人工确认）；**⑤ 代际守卫**——用 `window.fetch` 打桩让一个 `/update/drafts` 延迟落地，在它在途时传完另一个变体，落地后行内状态不得被打回「未上传」。

**代际守卫是全站不变式，不是某一页的补丁**：除弹层 `accounts.js`（不在 `PAGES` 里、无自动刷新）外，六个页面模块的 `refresh()` 都必须只认最后发起的那次响应。五页统一用 `core/api.js::makeGuard`；`release.js` 用等价的内联 `refreshSeq`（先于 `makeGuard` 存在、出过生产事故后加的，不动它）。守卫必须挡在**赋值/渲染之前**——状态被旧数据写脏后，后续任何纯本地重渲染（排序、过滤、展开）都会把脏数据画出来。`trend.js` 有**两个**乱序源（切档位 + 切「按日期/实时」模式），后者会把标题与四张图整体刷成日视图而分段控件还高亮着「实时」，故 `refreshDaily`/`refreshRealtime` 各自接收代际号在 await 后校验。新增页面模块时照抄这一套。

工作流页/用户页的时间维度同样要人工回归（改 `features/{blueprints,users}.js` 或 `core/{detail,range}.js` 后）：**① 三档位联动**——7/30/90 切换后，表格总量、环比列、脚注里的对比窗、展开详情的曲线天数四者必须同时跟随（30 档走服务器缺省，`rangeParams()` 返回 `undefined`，是独立分支）；**② 展开态跨档位存活**——展开一行再切档，行应保持展开且曲线重新按新档位拉取；**③ 跨页签**——在用户页改档位后切到工作流页，工作流页必须用新档位（`main.js` 只刷新激活页，靠 `show()` 补刷）；**④ 代际守卫**——`window.fetch` 打桩让 90 天请求延迟 1.5s，发起后立刻切 7 天，落地后顶栏与表格/脚注/详情图不得分叉；用户页还要用同样手法测 metric 切换的乱序；**⑤ 刷新持久化**——档位存在 `localStorage.cancongOps.rangeDays`，重载后恢复且数据一致。
