# Release Notes

本文件记录 cancong-ops 各版本的变更。遵循「面向使用者的价值 + 面向维护者的关键实现」双视角。

---

## 未发布

### 新增能力

**蓝图自进化中心 · 对接蚕丛独立版（两仓同批，TechDemos 自进化批 5 / 设计 §11）：契约对拍、执行器体检、feed 挂 Linux 包**

- **契约对拍**：本仓经回环调的 13 个蚕丛接口登记在 `lib/center/partner-ops.js`，蚕丛那边对应标成 `x-stability: partner`（只许加可选字段，有门禁）。新测试 `__tests__/cancong-contract.test.js` 读兄弟仓 TechDemos 的 `api-spec/dist/openapi.json`，校验桩响应与本仓请求逐字段落在规格里（迷你校验器 `__tests__/_openapi-mini.js`，零依赖、严格键），并要求本表 ≡ 规格 partner 集合 ≡ 用例实际调用集合；找不到 TechDemos ⇒ skip 并写明「未真对拍」。桩蚕丛从 `evolve-center.test.js` 挪到共享夹具 `__tests__/_evolve-fixtures.js`，契约测试校验的就是单测在用的那份桩。
- **执行器体检**（`lib/center/health.js`，`GET /v1/evolve/health`、`POST /v1/evolve/health/refresh`）：可达 / 独立版 / 在线契约（13 个 partner 接口齐全）不过 ⇒ 红灯，每日窗口与「立即处理」都不开跑（记一条失败批次，样本不标 batched、不烧重试）；BP_EVOLVE 未关 ⇒ 黄灯照跑；目标市场读不出 ⇒ 推送 / 导出 409 `executor_unhealthy`；起 run 回 503 ⇒ 本批样本原样退回（新 DAO `evoUnbatch`，attempts 不变）、本轮余下蓝图不跑、体检亮「缺工具」。启动时体检一次进日志；「自进化 → 队列」顶部显示状态条，补丁簇页按 `canPush` 置灰推送 / 导出。
- **feed 挂 Linux 包**：`lib/update.js` 变体改为表，新增可选变体 `linux-x64` / `linux-arm64`（规范名 `cancong-server-<ver>-linux-<arch>.tar.gz`，不派生解压道，启动补派生也跳过它们）；发布自检加「gzip 文件头」「原名架构与变体一致」两道；两个 exe 照旧必需；manifest 只含在场变体。版本发布页 Linux 行标「可选」。体检的版本行据此比对中心机蚕丛版本，落后给出带 sha 校验的升级命令（升级须 root，**不代执行**）。
- **部署顺序**：先升中心机蚕丛（带 partner 标签的版本），再升 OptServer——反过来体检会判契约不兼容、队列停跑。
- 测试 169 → 187（`cancong-contract` 2、`evolve-health` 11、`update-linux` 5）；牙齿：桩改回扁平 settings、规格去掉一个 partner 标签、撤体检门、503 改回 `evoReleaseBatch`、补派生不跳过 Linux，各自对应用例变红。

**蓝图自进化中心（两仓同批，TechDemos 自进化批 4）：补丁簇汇总 → 每日合成与审查 → 采纳后推成市场分支**

- 看板新增「自进化」页签，下分 **补丁簇 / 框架问题 / 留出对照 / 队列 / 配置** 五页。管理员可采纳（进篮子）/ 驳回（须写理由）/ 搁置补丁簇，标记框架问题「已修复于 vX」（之后新版本再报会标红回归），改上报白名单 / 留出概率 / 每日批处理时刻 / 目标市场；所有写操作留审计。
- 入库即增量写中心表（schema **v6**，新增 6 张表，见 `docs/ARCHITECTURE.md`）：同一签名再次上报**只加计数、不排队、不调模型**；已裁决的簇不会再产出合成补丁。
- 每日窗口（默认 02:00）或「立即处理」：经本机回环让同机蚕丛无头跑中心工作流 `center-blueprint/evolve-center/`（聚类 → 合成 → 独立审查），输入 / 输出走批目录文件；失败的批次自动重排一次，再败标红。合成补丁入库前确定性复核能否逐字套上。
- 「推送到市场」：取市场最新版装成副本、把篮子里的补丁簇按节点套上，一次推成 `publish/<工作流>-<版本+1>` 分支，提交说明逐簇写证据与审查结论；在新版上打不上的簇自动退回重新合成。工作流不在目标市场时可「导出补丁」（`git apply`）。
- 部署：新增 env `OPS_CANCONG_URL` / `OPS_CANCONG_TOOL` / `OPS_EVOLVE_WORK_DIR`；中心机的蚕丛独立版须以 `--env BP_EVOLVE=0` 安装（见 `docs/DEPLOYMENT.md` §8.1）。
- 测试 155 → 169（`__tests__/evolve-center.test.js`：桩蚕丛下的三颗牙齿——同签名零排队、已裁决簇不出补丁、多簇一分支版本 +1——以及失败重试、锚点退回、导出可 `git apply`、鉴权与审计）；两仓真闭环在 TechDemos `st/tests/evolve-center-push.spec.ts`；Linux 中心机部署演练（两个系统用户、看板推送 / 真模型立即处理）在 TechDemos `st/tests/evolve-center-node.spec.ts`。

**蓝图自进化上报（两仓同批，TechDemos 自进化批 3）：三类样本事件 + 上报配置接口 + gzip 入库钉死**

- 新事件类型 `bp_patch_proposal`（补丁提案）、`bp_patch_verdict`（本机裁决）、`framework_issue`（框架墙汇总）：同时进 `KNOWN_TYPES` 与 `deltasOf`（各 `case … return {}`，只建当日行，载荷存原始表，不进 `RECENCY_TYPES`）——与 `artifact_review_reject` 同一套「样本类事件」做法，理由见 `docs/API.md`。
- 新接口 `GET /v1/config/evolve`（免鉴权，进门禁白名单）/ `PUT /v1/config/evolve`（requireAdmin）：上报白名单与随机留出概率，存 meta 表 `evolve_config`，零 DDL；客户端拉不到或缓存过 24h 一律按空白名单。配置页签与审计日志已在自进化批 4 补上（见上条）。
- gzip：客户端改为整批 gzip 上报。`express.json` 本来就默认解压，这次补了一条真 gzip POST 入库的测试把它钉死，不再靠推理。
- 测试 151 → 155。

**原始事件按类型回读：`dao.qEventsByType(type, limit)`（只读，给跨仓闭环用例用）**

本服务自己的 stats 一律走聚合表、从不看原始表 —— 而采集端那边要验的恰恰是「我发出去的
payload，落到你库里之后形态没被改写」，那件事只有 `events.payload` 看得见（聚合表把它丢了）。
于是加这一个只读方法：按 `type` 倒序取最近 N 行，`limit` 夹在 `[1,200]`，**payload 原样回字符串**
（DAO 不猜内容，解析口径归调用方，免得两边各解一次而分歧）。不加索引 —— 这是排障/对拍面，
不在任何热路径上。

采集端（蚕丛 harness）据此把**两仓闭环钉进了回归链**：同进程起 `createApp({dbPath:':memory:'})`，
真状态机拒绝 → 真上报 → 真 ingest → 真库读回，六处变异全红。此前那次闭环是手工的，
而正是那一次抓出了「`aiReply:null` 被摊平落库」这类两端各测一半永远发现不了的缺陷。

**制品审批的「拒绝样本」入库 + 未知事件类型不再静默（两仓同批）**

新增事件类型 `artifact_review_reject`：客户端（蚕丛 harness）的制品审批里，同事否掉一条评审
意见时，把被圈选的原文、同事的原话、AI 的五字段回复与拒绝归因一并上报，用来改进**生成那份
文档的 prompt**。这是**第一个「样本类」事件** —— 与既有七类不同，它的价值全在原始
`events.payload` 里，因此**刻意不加任何聚合列**，只走全 0 bump 保当日行存在。三条要点写进了
`docs/API.md`：样本随 `events` 表按 `OPS_RETENTION_DAYS`（默认 90）清理（清理不认 type，
所以「攒半年再分析」这种用法会扑空）；取样本目前只能上服务器 `sqlite3` 手查（`/v1/export/*`
只导四张聚合表）；截断与脱敏全在客户端做完，服务端不重复截断。

**未知 type 现在会计数并在总览页暴露**（meta 键 `unknown_type_events`，
`GET /v1/stats/overview` 的 `unknownTypeEvents`，看板**仅在 >0 时**多出一张卡）。

- 动机：未知 type 的前向兼容行为（落原始表、计 accepted、不聚合）本身是对的，但**在界面上
  完全看不出来**。于是「客户端加了新事件类型而这边 `KNOWN_TYPES` 没跟上」与「客户端压根
  没发」长得一模一样 —— 零聚合、零报错、零日志。
- 理由与 `daily_hour` 的时钟异常丢弃计数是同一条，那处注释原话就是**「丢弃要计数并在 UI 上
  暴露，否则这是静默漏数据」**；这次把同一条规矩补用到 type 上。
- 零 schema 改动（`meta` 表 v1 就有），`user_version` 不动。

### 维护者要点

- ★★ **加新事件类型要改两处**：`ingest.js` 的 `KNOWN_TYPES` **和** `deltasOf`。
  后者没有对应 `case` 会走 `default: return null` 而 `continue`，当日聚合行压根不建出来 ——
  **症状与「压根没加白名单」一模一样**。（`bp_run_start` 是刻意只进白名单不进 `deltasOf` 的，
  所以不能写成「每个 KNOWN_TYPE 都要有 case」的通则。）
- `artifact_review_reject` **不进 `RECENCY_TYPES`**：这条事件是评审人在**局域网另一头**点的、
  由所属人实例代发，算进「实质使用」会把一台没人在用的机器标成今日活跃。
- 客户端仓（TechDemos）那边有一条**跨仓对拍用例**会真来读 `lib/ingest.js` 的源码比对
  `KNOWN_TYPES`，并额外钉「`artifact_review_reject` 在 `deltasOf` 里有 case」。
  改本文件的这两个常量时，那边会判红 —— 那是有意的。
- `stBumpHourDropped` 更名为 `stBumpCounter`（它本来就是按 key 累加的通用语句，
  两个计数器共用一条，免得各备一份 prepare 迟早漂）。行为零变化。

**看板时间维度第三期：使用时段分布 / 作息（schema v5 + 回填）**

回答「**大家什么时候在用**」。趋势页新增第三个模式「作息」，工作流详情面板新增 24×7 热力图——三个模式恰好是三个时间尺度：日（趋势）/ 分钟（实时）/ 周×时（结构）。新增 `GET /v1/stats/hours?blueprintId&days`。

- **粒度只到「全局 + 工作流」两层，用户级不做**：一年 876 万行的永久表换一个「某个人几点上班」的洞察，行数代价最高、决策价值最低，且容易被当成监工工具。
- **窗口固定近 30 天，不跟随顶栏范围**（面板上明说）。7 天档下每个「周几×小时」格子只有 1 个样本——那不是作息规律是随机噪声，而热力图看起来很有信息量，**比没有图更糟**。

关键决策与实现：

- **`day` 与 `hour` 同源于 `client_ts`**（转服务器本地时区），表内自洽。用 `server_ts` 分桶会把断网期间的活动全堆到重连那一刻，凭空造出假高峰；`day` 也必须同源，否则「昨天 23:00 发生、今早补发」的事件会记成 `day=今天/hour=23`——今天这一行冒出一根 23 点的柱子，而今天 23 点还没到。**代价是库里从此有两套时间口径，`daily_hour` 与 `daily_*` 永不可对账**，已写进 API/架构文档。
- **不合格事件丢弃而非回落**（与 recency 刻意不同）：recency 有个值比没有强，而时段分布里一个错误的小时会直接污染分布形状。丢弃数计入 `meta` 并由端点带出、UI 显示——否则这是静默漏数据。
- **重算是 DELETE + INSERT 而非 upsert**，因为目标行的键（client 本地日）与过滤列（`events.day` = server 接收日）不同源。正确性靠一条不变式：未来阀保证 `client_ts ≤ server_ts + 5min` ⇒ **client 日 ≤ server 日**，故按 `events.day` 过滤是超集、绝不会漏；多出的 spool 迟到件用第二个条件滤掉，其旧行不在 DELETE 范围内。
- **`daily_hour` 永久保留，不进 90 天清理**；但回填**没有日精度兜底**——小时信息只存在于 `events.client_ts`，events 一过期就物理不可重建，更早的日子永远空白（UI 标注实到起始日）。

两个实测踩到的坑：

- **`CAST(value AS INTEGER) + ?` 得到的是 REAL**：better-sqlite3 把 JS number 绑成 REAL，INTEGER + REAL = REAL，于是丢弃计数在 `meta`（TEXT 列）里存成了 `"1724.0"`。必须两层 CAST——绑定值 `CAST(? AS INTEGER)`、结果 `CAST(... AS TEXT)`。
- **`seed-demo.js` 造出了物理不可能的数据**：上一版给 `ts` 另撒了个 9~18 点的随机时刻，结果 `ts` 常常晚于接收时刻（时钟走快），未来阀把**28% 的事件**剔出了时段统计。阀没错，是造数错了。改为「先在工作时段取一个时刻，`ts` 与接收时刻同为它」。另外把「近 24h 按分钟撒事件」那块的密度从 50% 压到 15%——它的事件全落在最近一天，密度过高会让作息热力图变成「全员只在今天上班」的一条亮带（实测今天占全周 74%，现降到 29%），把周模式整个盖掉。

**看板时间维度第二期：最近活跃 / 沉默天数（schema v4 + 一次性回填）**

工作流页与用户页现在能回答「**谁不用了**」——这个问题此前**本质上答不出来**：一个 30 天没人跑的工作流，在「近 30 天」的区间聚合里压根没有行，给主表加一列「沉默天数」也渲染不出来。所以这一期的核心不是加列，而是**把沉默实体显式捞回结果集**。

- 两页主表新增「上次活跃」「沉默」两列，可排序；沉默天数超过当前范围 2 倍时标 ⚠（阈值随顶栏档位自适应，不写死常量——切 7 天看短期异常，切 90 天看长期流失）。
- **工作流页返回全量含沉默行**（区间指标补 0），尾部接在活跃行之后、整行压暗。
- **用户页 metric 分段加「沉默天数」**，切过去就是流失排行榜；从没实质使用过的人（只有心跳）排最前——那是最强信号，不是缺数据。
- CSV 两个导出各加两列，且**与看板走同一段装配代码**（含沉默实体与准入线），不是各写一份。
- 新增 `npm run backfill` 回填历史。

关键决策（完整推导见 [TIME-DIMENSION-PLAN.md](./TIME-DIMENSION-PLAN.md)）：

- **「上次活跃」只算实质使用，心跳不算**。反例就在手边：`installs.last_seen` 含心跳，客户端每 5 分钟跳一次，装了挂着从不用的人永远显示「5 分钟前」——照那个口径，看板会显示**全员活跃**，恰好把要看的东西盖住。
- **取 `client_ts` 而非 `server_ts`**，因为客户端有 spool 断网缓冲：用接收时刻会把「断网 3 天后重连补发」的活动记成今天，**过报新鲜度**正是 recency 最该避免的失效方向。未来阀是**单向**的——只有 `client_ts` 晚于 `server_ts` 才可能是时钟走快；早很多是正常的补发，拿"差值大"当异常判据会把断网用户的真实活跃时刻全删掉。
- **沉默工作流的准入线 = 历史累计 runs ≥ 3**。`blueprintId` 是用户可控且只增不减的（蚕丛支持自建/复制蓝图），跑一两年累计几百上千个 id，绝大多数是「建了跑一次就废」的实验品；不设线，沉默名单会被它们淹没，恰好埋掉真正值得警惕的那几个。被挡掉的个数在表底报出来，不静默隐藏。**用户侧不设此线**（`user@host` 来自真实机器，基数受人数约束）——这是有意的不对称。
- **`lastAt` 为空显示中性的「—」而不是「从未使用」**：空有两种可能且从数据本身分不出来——从未实质使用，或升级前的历史行尚未回填。表头 title 把两种可能说清，不臆断。

关键实现：

- **规则由两份实现表达，必须逐例对拍**：JS 的 `ingest.js::eventAtOf`（增量）与 SQL 的 `db.js::EVENT_AT_EXPR`（夜间重算 + 回填）。一旦漂移，夜间重算会**静默改掉 ingest 写对的值**且无人察觉。SQL 侧用 `strftime('%Y-%m-%dT%H:%M:%fZ', ...)` 归一为 UTC ISO——既保证字典序 = 时间序（`MAX` 才成立），也吃得下带偏移的旧格式。测试第一组用例逐例对拍两侧。
- **`last_at` 进了 `recompute*` 家族**，否则它会是库里唯一不自愈的字段。
- **迁移与回填分开**：`DDL_V4` 只有两条 `ADD COLUMN`（可空、无 DEFAULT、无约束的 `ADD COLUMN` 在 SQLite 是纯元数据操作，O(1)），随启动自动跑；扫全量 events 的重活留给 `npm run backfill`——塞进迁移事务会把启动阻塞到 systemd 的 `TimeoutStartSec`。回填按天分事务、幂等可重跑，**与增量互不依赖**（不跑也不影响新数据，只是历史行显示「—」）。
- **`scripts/seed-demo.js` 的 `ts` 原本是写死的常量**，所有事件共用同一个时刻——演示库里每个实体的「上次活跃」都会停在同一刻，沉默维度直接失真。改为逐事件按模拟日撒时刻，并显式造了三个「用过就再没用」的实体，让这个特性在演示库里看得见。
- **实测推翻了设计时的性能判断，据此加了索引并改了查询形状**。设计文档原把 `daily_user` 全表 `GROUP BY` 归为「多年后的尾巴」；实测千人×两年（73 万行）**当下就是 413ms**，而用户页 60s 自动刷新会反复付这笔钱。两个发现：① **光加索引没用**——SQLite 匹配不上 `user||'@'||host` 这个拼接表达式，仍走 `TEMP B-TREE`（356ms），必须同时把 `GROUP BY` 改成分列 `(user, host)` 才吃到覆盖索引（87ms），顺带避开拼接键的碰撞（`'a@b'+'c'` 与 `'a'+'b@c'` 同键）；② **87ms 仍太贵**，故拆两条路径——普通 metric 只对返回的 ≤100 行做点查（Top10 实测 **0.02ms**，快 4000 倍），全表扫只留给沉默排行与 CSV 导出。索引写入代价实测 +1.45µs/次 upsert（每天多 0.12 秒），`npm run bench` 全部验收线 PASS。

**工作流页 / 用户页补上时间维度（第一期：逐日下钻 + 环比）**

两页原本只有「区间累计总量」——一行数字、一张排名图，**没有任何"何时"的信息**。于是看不出谁在涨谁在跌，也没法从某个工作流下钻看它自己的曲线（趋势页有曲线但只有全局口径）。本期补两件事，**零 schema 改动、零回填**，只用已有的 `daily_blueprint` / `daily_user`（它们本来就是按天存的）：

- **环比列跟随当前排序列**：按 `运行` 排就显运行的环比，改排 `Token` 就变 Token 的环比。表永远只多一列、只有一个箭头，且总与当下关注的指标对齐。用户页由 metric 分段控件决定，环比列跟着那一列走。
- **点表格行展开详情**：该实体自己的日曲线 + 「本期 vs 上期」六格对比条。一次只开一行（多实例并存既费内存又让页面跳动）；对比条的数据在列表响应里已经带回，展开时**不再发请求**；日曲线按需拉 series 端点并按 id 缓存。
- 新增 `GET /v1/stats/blueprints/series?id&from&to` 与 `GET /v1/stats/users/series?user&host&from&to`；`/stats/blueprints` 与 `/stats/users/top` **纯增量**新增 `compare` 与每行 `cur`/`prev`，旧字段一个不动。

关键实现（三个都是踩过才知道的）：

- **环比的两个对比窗都截至昨日**（`lib/stats.js::compareWindows`）。主表总量与日曲线仍含今日——那是实时感，不动；但环比另起两个等长的完整自然日窗（缺省 30 天档 = `[今天-30, 今天-1]` vs `[今天-60, 今天-31]`）。**range 末尾的「今天」只过了一半，直接拿它当分子会让每天上午一片飘红、下午转绿**，那是钟点噪声不是趋势信号。曲线末点压暗 40% 并在标题标「末柱为当日，数据不完整」。range 内没有一整个完整自然日时（如 `from=to=今天`）`compare` 返回 `null`，不硬凑。
- **小基数改显绝对差**（`core/fmt.js::fmtDelta`）：两期任一 < 10 时不显百分比。长尾工作流从 1 涨到 3 就是 `+200%`，在表里比真正重要的 `+18%`（312→368）还刺眼；工作流页恰恰是长尾密集的地方。上期为 0 也走这一支，顺带避开除零。
- **「当日不完整」的提示放在图外的标题行**，不是图内。最初用 ECharts `markArea` 在最后一格铺底 + 标签，实测被 grid 直接裁掉——一格类目只有 30~40px 宽，「进行中」三个字在任何窄图/长区间下都放不下。图内只留末点压暗。
- **用户序列按 `user`/`host` 分开传参**，不拼 `user@host`：用户名里可能含 `@`，拼串切不开。同一 `user@host` 的多个 `install_id`（多 DATA_ROOT 实例）在序列端点里**按天合并成一行**，与 Top N 的去重口径一致。
- **代际守卫铺到全部页面**（`core/api.js::makeGuard`），不只是本次新增的两页。复测三档位联动时实测复现：慢的 90 天请求在快的 7 天请求之后落地，**顶栏显示「7 天」而表格渲染 90 天数据**，脚注还用权威口吻写着 90 天的对比窗。这是版本发布页栽过的同一类竞态（v0.4.0 后修的「代际守卫」），触发面不止手动连点——60s 轮询与 `visibilitychange` 也会并发。守卫必须挡在**赋值之前**：状态一旦被旧数据写脏，后续任何纯本地重渲染（排序、展开）都会把脏数据画出来。详情图另需比**实例身份**而非只判 `expandedKey`——同一行换档位时 key 不变，光判 key 挡不住旧序列画进新图。

  同一个洞在其余四页也存在（此前一直没人踩到，因为没有脚注这种会把错误"写成声明"的元素），一并补上：`trend.js` 最险——它有**两个**乱序源，切「按日期/实时」模式时慢的日视图后落地，会把标题和四张图整体刷成日视图，而分段控件还高亮着「实时」；`failures.js` 是档位乱序；`overview.js`/`installs.js` 无 range 参数，但 60s 轮询与 `visibilitychange` 照样并发，旧快照落地就是一次 lost update（`installs` 的 `rows` 被写脏后，纯本地的过滤/排序会一直画着旧列表）。`release.js` 保留它自己的 `refreshSeq`（等价实现，出过生产事故后加的，不动）；`accounts.js` 是弹层、不在 `PAGES` 里、无自动刷新，无需守卫。至此「`refresh()` 只认最后发起的那次」成为全站不变式，已写进 ARCHITECTURE 的人工回归清单。

后续两期（沉默天数、作息分布）的完整设计与取舍留档见 [TIME-DIMENSION-PLAN.md](./TIME-DIMENSION-PLAN.md)——含一条已确认的坑：客户端发的 `ts` 是 **UTC**（`toISOString()`），设计文档里 `+08:00` 那个示例从来没对过，P3 做时段分布必须服务端解析转换，**不能字符串切片**。

### 修复

- **版本发布页：「发布」按钮无解释地点不动，以及上传成功的包又显示「未上传」**。两个现象同一个根因——**行内状态与「发布」闸门只认版本输入框里那一个版本，而服务端草稿区是按版本分桶的多份状态**；两者一分叉，已传成功的包就在行内凭空消失。「未上传」的真实含义是"当前填的这个版本号下没有这个包"，字面却读作"你根本没传上去"，所以极难自查。分叉有三个入口，都已堵上：
  - **补填版本号不补跑上传**：版本框空着选包时走 `needVersion()` 早退，文件只进 `picked`；随后补填版本号的 `input` 监听器只清提示、**不补跑上传**。而第二个包因版本号已就位自动传了——先选包的变体永远停在「已选待传」，用户以为两个都传了，「发布」却一直灰着。现在版本号**落定时**（`change`，失焦/回车）自动补跑被搁置的上传。挂 `change` 不挂 `input` 是硬要求：逐字输入 `0.4.10` 会在打到 `0.4.1` 时抢跑上传，而 `verLocked` 会把版本号锁死在那个错版本上。文件名版本对不上的（带 `rowErr`）刻意不补传，仍需人工确认后点「上传」。
  - **换版本 / 静默预填让输入框版本与实际上传版本分叉**：`refresh()` 会在版本框为空时静默填入草稿区最新版本，用户当成自己填的；「换版本」又只清本地已选文件、对服务端已传的包只字不提。现在包在别的版本里会**直接点破**（`⚠ 版本 X 下没有此包——它在草稿 Y 里`），预填也会在闸门行说明来源，「换版本」明说服务端的包不受影响。
  - **并发刷新用旧快照覆盖**：`refresh()` 原先没有代际守卫，`data` 由最后落地的响应决定。上传是分钟级长请求，期间 60s 轮询与 `visibilitychange`（等待时切走再切回）必然并发；一个「上传完成前发出、完成后落地」的旧快照会把刚传好的变体抹掉——读条走完、传成功，界面却回到「未上传」。现在 `refresh()` 只认最后一次发起的响应，上传成功还会用**服务端回执就地渲染**，不再把成功态押在随后那次 GET 上。
- **「发布」禁用时不给理由**：按钮禁用态只有 `opacity: .45`，旁边一片空白，用户无从判断是"包没传上去"还是"页面坏了"。新增 `#rel-gate` 专放闸门原因（差哪个变体、文件已选好待点「上传」、包在别的草稿里、有变体正在上传、草稿区加载失败），与放操作结果的 `#rel-msg` 分开，互不覆盖。
- **待办态与完成态、空态同色**：`.rel-status` 三种语义共用 `--muted` 灰字，「已选待传」和「未上传」「✓ 已上传」看着一模一样，正是上面两个故障看不出来的直接原因。待办态改用 amber 信号色（`.rel-todo`），同一行的「上传」按钮跟着高亮。

### 验证

113 个 `node:test` 用例全绿（新增 12 个覆盖对比窗边界与两个 series 端点：今日排除的锚点断言、7 天/历史区间/单日三种窗口形态、逐日补零、未知 id 回全零而非 404、多 install 合并、参数校验 400）。时间维度经 Playwright 端到端实测：环比列随排序/metric 切换移位、点行展开与折叠、展开态在排序与 metric 切换后保持、对比条数值与小基数绝对差（`失败数 4→12` 显 `+8`、`活跃时长` 显 `-10%`）、末柱压暗与标题提示。**三档位联动单独复测**（200 天种子库，保证 90 天档的上期窗也有数据）：7/30/90 三档的 range/cur/prev 天数一致且首尾相接、series 长度跟随、30 档走服务器缺省分支、展开态跨档位存活并重新拉取、跨页签切换沿用新档位、`localStorage` 重载恢复；环比边界另做穷举（上期为 0 → 绝对差不出 `Infinity`、两期为 0 → `—`、本期归零 → 负绝对差、持平 → `0%`、时长列走 `fmtDuration`）。竞态用 `window.fetch` 打桩做 A/B 对照：关守卫时复现「顶栏 7 天 / 表格 90 天」，开守卫后档位与 metric 两种乱序时序均一致。守卫铺开后逐页复验：`trend` 的模式乱序（实时视图未被日视图覆盖，x 轴仍是 1440 个分钟点）与档位乱序（7 点）、`failures` 的档位乱序（kind 总数 130 = 7 天真值，而非 90 天的 378——**最近失败列表因服务端 `LIMIT 100` 在两个档位下都是满 100 行，不能用它当观测量**）、`overview`/`installs` 用伪造的慢响应体注入哨兵值（`99999` / `STALE-USER`），确认哨兵不出现在最终 DOM。

发布面经 Playwright 端到端实测：先复现两个故障（network log 佐证「slim 从未发出上传请求」、`staging/0.4.1/with-linux.exe` 确实在盘上而界面显示「未上传」），打补丁后同一时序全部通过；代际守卫用 `fetch` 打桩做了 A/B 对照——关掉守卫时刚传成功的变体被延迟落地的旧快照打回「未上传」，开启后保持 `✓`。回归覆盖：文件名版本不符不自动补传、逐字输入 `0.4.10` 不抢跑、删草稿、下架回滚、「填入版本」、页签切走再切回。

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
