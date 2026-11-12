# cancong-ops API 契约

> 双端唯一契约。客户端(遥测上报)与看板(数据消费)都以本文件为准。
> 所有响应统一 `{ ok: boolean, ... }`；成功查询为 `{ ok: true, data: {...} }`，失败为 `{ ok: false, error: "..." }`。
> Base URL 默认 `http://<host>:5900`。**上报接口 `POST /v1/events` 开放**（内网即信任，采集端不带任何凭据）；**看板页面与其余 `/v1` 接口需登录**——浏览器带 `ops_session` Cookie，脚本可选用 `Authorization: Bearer <token>`(token 来自 `/v1/auth/login` 返回体)。全局门禁在 `server.js::createAuthGate`，逻辑收敛在 `lib/auth.js`；账号/登录端点与预置管理员见 [README「登录鉴权」](../README.md#登录鉴权)。

## 目录

- [上报接口 `POST /v1/events`](#上报接口-post-v1events)
  - [事件信封](#事件信封envelope)
  - [事件类型与 payload](#事件类型与-payload)
- [健康检查 `GET /healthz`](#健康检查-get-healthz)
- [查询接口 `GET /v1/stats/*`](#查询接口-get-v1stats)
- [CSV 导出 `GET /v1/export/*`](#csv-导出-get-v1export)
- [应用自动更新 `/v1/update/*`](#应用自动更新-v1update)
- [服务发现 `GET /v1/discovery`](#服务发现-get-v1discovery)
- [框架问题 `/v1/fw-issues`](#框架问题-v1fw-issues)
- [错误响应](#错误响应)

---

## 上报接口 `POST /v1/events`

批量上报事件。单批 **≤ 500 条**，body **≤ 1 MB**。

**请求体**
```jsonc
{ "events": [ <envelope>, <envelope>, ... ] }
```

**响应** `200`
```jsonc
{ "ok": true, "accepted": 12, "dup": 3 }
// 若批中有非法事件，附带 rejected（纯增量字段，合法字段不变）
// { "ok": true, "accepted": 10, "dup": 0, "rejected": 2 }
```

- `accepted`：首次入库并计入聚合的事件数。
- `dup`：重复事件(eventId 已存在 / 心跳已见过)，被幂等丢弃——**重发安全**。
- `rejected`：结构非法被跳过的事件数(缺字段、超长、schemaVersion 不符)。非法事件**不会**整批拒绝，仅跳过自身。

**幂等保证**：客户端断网补发整批时，服务器按 `eventId` 去重(`INSERT OR IGNORE`)，聚合只在真正入库时累加。客户端无需精确一次投递。

### 事件信封(envelope)

```jsonc
{
  "schemaVersion": 1,              // 必填，严格等于数字 1（字符串 "1" 会被拒）
  "eventId": "uuid",               // 必填，非空字符串 ≤128；服务器按此幂等去重
  "type": "session_start",         // 必填，非空 ≤64；见下表
  "ts": "2026-07-02T01:30:00.000Z",  // 客户端 toISOString()，即 **UTC**；见下方「ts 的口径」
  "installId": "uuid",             // 必填，非空 ≤128
  "user": "zhangsan",              // 必填，非空 ≤256（os.userInfo().username）
  "host": "DESKTOP-XXXX",          // 必填，非空 ≤256（os.hostname()）
  "platform": "win32",             // 选填，process.platform
  "appVersion": "1.4.0",           // 选填，package.json version
  "channel": "packaged",           // 选填，packaged | dev（看板可过滤开发噪声）
  "bootId": "uuid",                // 选填，每进程启动生成
  "payload": { }                   // type 专属字段，见下
}
```

**校验规则**：`schemaVersion === 1` 且 `eventId/type/installId/user/host` 均为非空字符串且不超长。任一不满足 → 该事件计入 `rejected` 并跳过。

**用户口径**：去重键为 `user@host`(同一人多个数据目录实例不重复计人)；`installId` 用于实例维度统计与换名兜底。

**`ts` 的口径（格式已锁定）**：必须是 `toISOString()` 的 **UTC** 形态（`Z` 结尾）。本文档早期示例写成 `"...+08:00"`，与客户端实现**从未相符**（`server-telemetry/index.js` 一直发 UTC），已改正。

- **归日（`day` 列）仍以服务器接收时刻为权威**，客户端时钟不可信——这条不变。
- 但 `ts` 已从「仅留档」升格为**两个维度的权威源**：`last_at`（上次实质使用）与 `daily_hour`（使用时段分布）。原因是客户端有 spool 断网缓冲，用接收时刻会把断网期间的活动记成"刚刚"。
- **别改成带偏移的本地格式**：服务端按 UTC 解析，改了会让作息热力图整体偏移且**不报任何错**；铺开期内两种格式还会混在同一张表里无法分辨。客户端侧已有 parity 用例钉死此格式（`server-telemetry/__tests__/telemetry.test.js`）。

### 事件类型与 payload

> **术语**：本文档中「工作流」= 内部字段 `blueprintId`（事件类型 `bp_run_*` 沿用既有契约名，不改）。

| type | 触发点 | payload | 聚合去向 |
|------|--------|---------|---------|
| `instance_online` | 实例上线 | `{ port, liveSessions, welinkUid? }` | 刷 installs.live_sessions（与 welink_uid，同心跳）；建当日行(计数 0) |
| `instance_heartbeat` | 定时 5min | `{ liveSessions, welinkUid? }` | **不落 events**；hb_seen 去重后 `daily_user.heartbeats+1`；`welinkUid`（可选，拼音首字母+工号）写 `installs.welink_uid`，形态不对按没带、绝不拒事件 |
| `session_start` | 会话开始 | `{ tool, cwdHash }` | `daily_user.sessions+1`、`daily_tool.sessions+1` |
| `session_end` | 会话结束 | `{ tool, durationMs, exitCode, inputTokens, outputTokens }` | `session_ms += durationMs`；**`daily_user.in/out_tokens += tokens`(token 总量权威)** |
| `bp_run_start` | 工作流 run 新建 | `{ blueprintId, runId, tool }` | **只落 events 不聚合**(run 计数以终态为准，避免跨日双计) |
| `bp_run_end` | 工作流 run 终态 | `{ blueprintId, runId, status, activeMs, haltReason?, interruptions, inputTokens, outputTokens }` | daily_user 按 `status` 落 `runs_*` + `run_active_ms`；**`daily_blueprint` 落 runs/active_ms/interruptions/token(工作流归因)** |
| `failure_event` | 异常信号 | `{ source, kind, reason, tool, runId?, blueprintId? }` | `daily_user.failures+1`、`daily_fail(day,version,kind)+1`；**带 `blueprintId` 则 `daily_blueprint.failures+1`** |
| `framework_issue` | 客户端整合器汇总的框架墙（守卫拒绝 / spawn 故障等），不受白名单；客户端同时发一份给自进化服务 | `{ signature, category, ruleOrCode, sample, nodeId, blueprintId, count, passedAfter }` | 样本类：只建当日行；同事务聚合进 `fw_issues` |
| `artifact_review_reject` | 制品审批：一条评审意见被拒 | `{ aidHash, tool, kind, round, turns, reviewer, assessment, hadChange, rejectKind, quote, comment, reason, aiReply{…}, promptVer, genPromptRef, bytes, truncated }` | **只建当日行(计数 0)，不落任何聚合列** —— 见下方「样本类事件」 |

**v0.2.0 新增 payload 字段**（客户端上报；缺失按 0 / 不归因，服务器 graceful）：
- `session_end.inputTokens` / `outputTokens`（int ≥0）：**会话级 token = 总量权威**，进 `daily_user`（概览/趋势/Top 用户）。
- `bp_run_end.inputTokens` / `outputTokens`（int ≥0）：**run 级 token = 工作流归因子集**，进 `daily_blueprint`（工作流页）。
- `bp_run_end.interruptions`（int ≥0）：运行中用户插话/打断次数（「用户中断」）。
- `failure_event.blueprintId`（string，可选）：把失败归因到具体工作流；缺失则仅计入总量失败，不归因工作流。

> **Token 防重复计数**：会话含多个 run，run token 是会话 token 子集。故会话 token 与 run token 分别进 `daily_user` 与 `daily_blueprint` 两个视图，各自求和、互不重复（`sum(工作流 token) ≤ sum(总量 token)`，非 run 活动不计入工作流）。

**样本类事件（`artifact_review_reject`，未发布）**——与上面所有「指标类」事件不同，它的价值
**全在原始 `events.payload` 里**（被拒意见的原话 + AI 回复），用来改进生成制品的那个 prompt：

- **刻意不加任何聚合列**。加了列就得同步改 `lib/db.js` 的 recompute SQL，**漏一处，夜间 3:00
  的补算会把 ingest 写对的值重算成 0，而且从数据本身看不出来**。它只走全 0 bump 保当日行存在。
- **不进 `RECENCY_TYPES`**：这条事件是**评审人在局域网另一头**点的、由所属人实例代发 ——
  算进「实质使用」会把一台没人在用的机器标成今日活跃。「使用」的定义只该有一个。
- ⚠ **样本随 `events` 表按 `OPS_RETENTION_DAYS`（默认 90）整表清理**，清理不认 type。
  也就是说这条遥测**只支持「近 90 天拿样本去改 prompt」这一种用法**；想攒半年再回头分析，
  到时候会是空的。
- ⚠ 取样本目前**只能上服务器 `sqlite3` 手查**：`/v1/export/*` 只导四张聚合表，没有原始事件导出。
- 客户端侧已做完截断（逐字段字节上限，合计 ≤8KB）与脱敏（抹 32 位十六进制串、身份只发别名
  `r1`/`r2`/`owner`）。服务端**不重复截断**——到这儿再截等于全文已经出网了。

- **未知 type**(v2 前向兼容)：结构合格即落 events 原始表、**不做任何聚合**、计入 `accepted`。旧服务器遇新客户端不丢数据。
  **（未发布）额外计数**（meta 键 `unknown_type_events`，累计非当日），由 `GET /v1/stats/overview`
  的 `unknownTypeEvents` 带出，看板总览**仅在 >0 时**多出一张卡。
  ★ 理由与 `daily_hour` 的丢弃计数同一条：**丢弃/不聚合要计数并在 UI 上暴露，否则这是静默漏数据**。
  这里它防的是**跨仓漂移** —— 客户端加了新事件类型而这边 `KNOWN_TYPES` 没跟上时，
  症状是「看板零样本 + 零报错 + 零日志」，与「客户端压根没发」完全无法区分。
  ★★ 加新 type 时**两处都要改**：`KNOWN_TYPES` **和** `deltasOf`（后者没有 `case` 会走
  `default: return null`，照样 `continue`，当日行都不建）。客户端那边有一条跨仓对拍用例
  （`TechDemos/scripts/__tests__/telemetry-known-types-parity.test.js`）会真来读本文件对拍。
- **数值净化**：`durationMs`/`activeMs`/`liveSessions`/`inputTokens`/`outputTokens`/`interruptions` 仅当为正有限数才计入，否则按 0。
- **隐私约定(v1)**：不上传 cwd 明文、prompt、会话内容；`cwdHash` 为 sha256 前缀，仅用于项目数统计。

---

## 健康检查 `GET /healthz`

```jsonc
GET /healthz → 200 { "ok": true }
```
挂在门禁之前（白名单），探活永不受鉴权影响。

---

## 查询接口 `GET /v1/stats/*`

看板唯一契约。时间参数 `from`/`to` 为**本地日** `YYYY-MM-DD`(含端点)；缺省 `to=今日`、`from=to-29`(近 30 天)。跨度 > 400 天或格式非法 → `400 bad range`。

### `GET /v1/stats/overview`
今日概览(无参数)。
```jsonc
{ "ok": true, "data": {
  "today": "2026-07-04",
  "activeUsersToday": 21,      // 今日活跃用户(user@host 去重)
  "activeUsersWeek": 40,       // 近 7 天(含今日)活跃用户
  "onlineInstalls": 21,        // last_seen 在 10 分钟内的实例数
  "sessionsToday": 27,
  "sessionMsToday": 46090214,
  "runsToday": 19,             // done+failed+halted
  "failuresToday": 7,
  "inTokensToday": 128340,     // token 总量(来自 session_end)
  "outTokensToday": 31200,
  "unknownTypeEvents": 0       // （未发布）KNOWN_TYPES 之外的事件**累计**条数(非当日)。
                               // >0 = 客户端在发这边不认识的类型，即两仓事件清单漂了：
                               // 那些事件落了原始表但**不做任何聚合**。总览页仅在 >0 时出卡。
} }
```

### `GET /v1/stats/dau?from&to`
逐日 DAU/WAU、会话数与时长。WAU 为该日往前 7 天滑窗内活跃用户并集。
```jsonc
{ "ok": true, "data": { "from": "...", "to": "...", "days": [
  { "day": "2026-07-01", "dau": 18, "wau": 33, "sessions": 40, "sessionMs": 3600000,
    "inTokens": 220400, "outTokens": 51200 }
] } }
```

### `GET /v1/stats/versions`
版本分布(按 install 最新上报的 app_version；30 天不活跃的僵尸实例不计)。
```jsonc
{ "ok": true, "data": { "versions": [
  { "version": "1.4.0", "installs": 17, "users": 17 }
] } }
```

### `GET /v1/stats/tools?from&to`
各工具会话数与时长。
```jsonc
{ "ok": true, "data": { "from": "...", "to": "...", "tools": [
  { "tool": "claude", "sessions": 261, "sessionMs": 478800000 }
] } }
```

### `GET /v1/stats/runs?from&to`
逐日 run 终态分布与活跃时长。
```jsonc
{ "ok": true, "data": { "from": "...", "to": "...", "days": [
  { "day": "2026-07-01", "done": 12, "failed": 2, "halted": 1, "activeMs": 90000 }
] } }
```

### `GET /v1/stats/failures?from&to`
失败类型分布、按版本失败率、最近失败事件(最多 100 条)。
```jsonc
{ "ok": true, "data": {
  "from": "...", "to": "...",
  "kinds": [ { "kind": "rate_limit", "n": 50 } ],
  "byVersion": [
    { "version": "1.4.0", "failures": 67, "runs": 255, "rate": 0.2627 }
    // 某版本有失败但无 run 时 rate 为 null（不返回 Infinity/NaN）
  ],
  "recent": [
    { "eventId": "...", "serverTs": "2026-07-04T04:14:55.009Z",
      "user": "user006", "host": "HOST-006", "appVersion": "1.4.0",
      "payload": { "source": "error_autoresume", "kind": "rate_limit", "reason": "..." } }
    // 坏 payload 时 payload 为 null
  ]
} }
```
> 注意：`kinds`/`byVersion` 走永久聚合表，`recent` 读 events 原始表——受 90 天保留窗约束。

### `GET /v1/stats/users/top?from&to&metric&limit`
高频用户 Top N。`metric` ∈ `sessions｜runs｜failures｜sessionMs｜tokens｜silentDays`(默认 `sessions`；非法值 `400 bad metric`)；`limit` 上限 100，**默认值随 metric 而变**——普通指标 10，`silentDays` **50**（流失名单的用处是看全，Top 10 只够看最久的那几个）。服务器按 `metric` 排序返回，前端切换 metric 即重查。

> `metric=silentDays` **与其余五个不同源**：那五个按区间聚合排序，而沉默用户在区间聚合里根本没有行、永远排不出来。此值改按不带 range 的 recency 排（`lastAt` 升序 = 沉默降序，`lastAt` 为 `null`——只装了从没实质用过——排最前），区间指标列全部补 0。
```jsonc
{ "ok": true, "data": { "from": "...", "to": "...", "metric": "tokens",
  "compare": { "cur": { "from": "...", "to": "..." }, "prev": { "from": "...", "to": "..." } },
  "users": [
  { "user": "user025", "host": "HOST-025", "sessions": 39, "runs": 23, "failures": 6,
    "sessionMs": 80527678, "inTokens": 900453, "outTokens": 173400, "tokens": 1073853,
    // recency（不带 range 的全局量，见下方「上次活跃与沉默天数」）
    "lastAt": "2026-08-03T09:12:44.180Z", "silentDays": 0,
    // 环比用：同名字段在两个对比窗上的聚合（见下方「环比对比窗」）
    "cur":  { "sessions": 31, "runs": 17, "failures": 4, "sessionMs": 58800000, "tokens": 699157 },
    "prev": { "sessions": 68, "runs": 37, "failures": 12, "sessionMs": 52560000, "tokens": 1170950 } }
] } }
```

### `GET /v1/stats/blueprints?from&to`
各工作流(内部 blueprintId)的运行/失败/E2E/中断/token，按 run 总数倒序，**尾部接沉默工作流**（区间内零活动但历史跑过的，指标补 0）。
```jsonc
{ "ok": true, "data": { "from": "...", "to": "...", "today": "2026-08-03",
  "compare": { "cur": { "from": "...", "to": "..." }, "prev": { "from": "...", "to": "..." } },
  "silentMinLifetimeRuns": 3,   // 沉默名单的准入线（常量，见下）
  "hiddenSilent": 128,          // 未达准入线、被隐藏的沉默工作流个数
  "blueprints": [
  { "blueprintId": "fix-tests", "runsDone": 82, "runsFailed": 26, "runsHalted": 23, "runs": 131,
    "failures": 39, "activeMs": 37766873, "interruptions": 136,
    "inTokens": 1294296, "outTokens": 262175, "tokens": 1556471,
    "lastAt": "2026-08-03T09:12:44.180Z", "silentDays": 0, "lifetimeRuns": 385,
    "cur":  { "runs": 144, "runsDone": 90, "runsFailed": 30, "runsHalted": 24, "failures": 42,
              "activeMs": 36360000, "interruptions": 111, "inTokens": 1160000, "outTokens": 242806, "tokens": 1402806 },
    "prev": { "runs": 83, "…": "同 cur 的字段集" } },
  // 沉默行：区间指标全 0，但带 lastAt/silentDays/lifetimeRuns，且照样带 cur/prev
  { "blueprintId": "legacy-deploy", "runs": 0, "…": "其余区间指标均为 0",
    "lastAt": "2026-04-23T16:58:42.572Z", "silentDays": 102, "lifetimeRuns": 6 }
] } }
```
- `runs` = done+failed+halted；`failures` = 归因到本工作流的 `failure_event` 数(带 blueprintId)。
- `activeMs` 为「E2E 活跃时长」口径(累加 bp_run_end.activeMs)；`interruptions` 为运行中用户中断次数。
- `lifetimeRuns` = **历史累计** run 数（不受 range 约束），仅用于沉默名单的准入判定。

#### 上次活跃与沉默天数(`lastAt` / `silentDays` / `hiddenSilent`)

- **`lastAt` = 上次实质使用**：只认 `session_start`/`session_end`/`bp_run_end`/`failure_event`，**心跳与 `instance_online` 一律不算**。反例是 `installs.last_seen`——它含心跳，装了挂着不用的人永远显示「5 分钟前」，照那个口径看板会显示全员活跃。取值优先 `client_ts`（事件真实发生时刻，避免 spool 断网补发把活动记成"今天"），仅当 `client_ts > server_ts + 5min`（时钟走快）或不可解析时回落 `server_ts`。
- **`lastAt` 为 `null`** 有两种可能且**从数据本身分不出来**：① 从未实质使用（只有心跳）；② 是升级到 schema v4 之前的历史行、尚未跑 `npm run backfill`。看板显示中性的「—」，不臆断。
- **`silentDays`** = `lastAt` 的本地日距 `today` 的天数（今天用过 = 0）；`lastAt` 为 `null` 时为 `null`。它是**全局量**，不随 `from/to` 变——切 90 天不会让一个沉默 40 天的实体变成沉默 0 天。
- **沉默名单准入线 `silentMinLifetimeRuns`（= 3）**：只有区间内零活动的工作流才需要过线，历史累计 run 数低于它的不列出，个数计入 `hiddenSilent`。理由：`blueprintId` 是用户可控且只增不减的（蚕丛支持自建/复制蓝图），历史累计几百上千个 id 里绝大多数是「建了跑一次就废」的实验品，不设线会把真正值得警惕的「曾经在用、现在不用了」淹掉。**用户侧不设此线**（`user@host` 来自真实机器，基数受人数约束）——这是有意的不对称。

#### 环比对比窗(`compare` / `cur` / `prev`)
上面两个端点的**行内总量仍是 `from~to` 全区间(含当日)**——那是实时感，不动。环比另起两个窗口，**两端都截至昨日**、各取与 `from~to` 等长的完整自然日：

| range | `compare.cur` | `compare.prev` |
|---|---|---|
| 缺省 `[今天-29, 今天]` | `[今天-30, 今天-1]` | `[今天-60, 今天-31]` |
| 显式历史区间(`to` < 今天) | 即 range 自身 | 紧邻其前的等长窗 |

- **为什么不直接拿 range 当分子**：range 末尾的「今天」只过了一半，直接比会让每天上午一片飘红、下午转绿——那是钟点噪声不是趋势信号。
- `compare` 为 `null`（且各行不带 `cur`/`prev`）当且仅当 range 内**没有一整个完整自然日**（如 `from=to=今天`）。消费方必须处理这一支。
- `cur`/`prev` 的字段是行内同名数值字段的子集，看板按当前排序列取同名字段算环比；**两期任一 < 10 时改显绝对差**而非百分比（小基数下 1→3 就是 +200%，是噪声）。

### `GET /v1/stats/blueprints/series?id&from&to`
单个工作流的逐日序列（看板明细表「点行展开」用）。`id` 必填非空 ≤256，否则 `400 bad id`；**未知 id 返回全零序列而非 404**（工作流可能在区间外才有数据）。缺失日**补零**，不缺行。
```jsonc
{ "ok": true, "data": { "id": "fix-tests", "from": "...", "to": "...", "days": [
  { "day": "2026-07-05", "runsDone": 2, "runsFailed": 1, "runsHalted": 0, "failures": 1,
    "activeMs": 512000, "interruptions": 3, "inTokens": 21000, "outTokens": 4200 }
] } }
```

### `GET /v1/stats/users/series?user&host&from&to`
单个用户(`user@host`)的逐日序列。`user` 与 `host` **分开传**（用户名里可能含 `@`，拼串切不开），任一缺失 `400 bad user/host`。同一 `user@host` 的**多个 install_id 按天合并成一行**（与 Top N 的去重口径一致）。
```jsonc
{ "ok": true, "data": { "user": "user002", "host": "HOST-002", "from": "...", "to": "...", "days": [
  { "day": "2026-07-05", "sessions": 3, "sessionMs": 4200000, "runsDone": 2, "runsFailed": 0,
    "runsHalted": 1, "failures": 0, "activeMs": 900000, "inTokens": 31000, "outTokens": 6100 }
] } }
```
- 两个 series 端点都走 `daily_*` 聚合表，**不读 events**，因此不受 90 天保留窗约束。
- 索引口径：`daily_blueprint` 主键 `(day, blueprint_id)` 以 day 先导，按 id 过滤是范围内小规模扫；`daily_user` 按 `user/host` 过滤要扫范围内全部行（90 天千人 ≈ 9 万行、十毫秒级）。这是**按需下钻**而非首屏，故未为其新增索引。

### `GET /v1/stats/hours?blueprintId&days`
使用时段分布（作息）：24×7 热力图数据。`blueprintId` 缺省/空 = **全局**；`days` 默认 30、上限 400。只返回非空格子，补零交前端。
```jsonc
{ "ok": true, "data": {
  "blueprintId": "", "days": 30, "from": "2026-07-05", "to": "2026-08-03",
  "firstDay": "2026-07-05",     // 窗口内实际有数据的最早一天（null = 窗口内无数据）
  "coveredDays": 30,            // 实到自然日数，≠ days（早期可能无数据或已过 events 保留期）
  "droppedClockSkew": 12,       // 因时钟异常/无 ts 被剔出时段统计的累计事件数（UI 必须显示）
  "cells": [ { "weekday": 1, "hour": 10, "events": 42, "sessions": 12, "runs": 18 } ]
} }
```
- `weekday`：**0 = 周日**、1 = 周一 …… 6 = 周六。
- **窗口固定，不跟随顶栏 `from`/`to`**（本端点也不接受 `from`/`to`）。理由：7 天档下每个「周几×小时」格子只有 1 个样本，那不是作息规律是随机噪声，而热力图看起来很有信息量——比没有图更糟。顶栏 range 的语义是「统计区间」，作息是相对稳定的结构量，两者本就不该同步。
- `blueprintId` 超 256 字符 → `400 bad id`。

#### 时段分布的两条口径警告（务必读）

1. **`daily_hour` 与 `daily_*` 是两套时间口径，两表永不可 join / 对账。** 时段表的 `day` 与 `hour` **同源于 `client_ts`**（事件真实发生时刻，转服务器本地时区）；其余聚合表的 `day` 是**服务器接收时刻**固化的。取 `client_ts` 是因为客户端有 spool 断网缓冲——用接收时刻分桶会把断网期间的活动全堆到重连那一刻，凭空造出假高峰。`day` 也必须同源，否则「昨天 23:00 发生、今早补发」的事件会记成 `day=今天/hour=23`（今天 23 点还没到），24×7 图里跨午夜的事件还会落进错格子。
2. **全局行 ≠ 各工作流行之和。** 会话类事件（`session_start`/`session_end`）没有 `blueprintId`，只进全局行；工作流行只含 `bp_run_end`/`failure_event`。拿这两个数对账一定对不上，这是设计使然。

不合格事件（`client_ts` 缺失/不可解析，或超过 `server_ts + 5min` 的时钟走快）**直接丢弃**并计入 `droppedClockSkew`——不像 recency 那样回落 `server_ts`：recency 有个值比没有强，而时段分布里一个错误的小时会直接污染分布形状。

> ⚠️ 时段口径依赖部署机时区，**TZ 一旦定下不可改**——改了之后重跑回填会与增量积累的行对不上，且从数据本身看不出来。见 [DEPLOYMENT §4.1](./DEPLOYMENT.md)。

### `GET /v1/stats/realtime?window=`
实时活动：近 `window` 分钟(默认/上限 1440 = 24h)**按分钟直查 events**，无新增存储。只返回**非空分钟桶**，缺失分钟补零交前端。
```jsonc
{ "ok": true, "data": {
  "window": 1440,
  "now": "2026-07-04T09:30:12.000Z",
  "buckets": [
    { "min": "2026-07-04T09:28",   // UTC 分钟(server_ts 前 16 位)；前端转本地 HH:MM
      "events": 42, "sessions": 6, "runsDone": 3, "runsFailed": 1, "runsHalted": 0,
      "failures": 1, "tokens": 128400, "activeUsers": 5 }
  ]
} }
```
- `tokens` 口径与 daily 一致(仅 `session_end` 的 in+out，防双计)。
- `activeUsers` = 该分钟内有事件的去重 `user@host`——是**活跃**（在做事）而非**在线**（心跳不落 events，无法做分钟在线数）。
- 索引路径：`day` 先导(ix_events_day)缩到近 ~2 天，再按 `server_ts` 精确切窗。
- 性能：24h/1min 直查需扫 ~10 万行(CPU-bound ~1s 级)。因分钟桶 60s 才变、看板 60s 刷新，端点带 **30s 响应 memo**(§8.3)按 window 缓存、多看板共享，实际近即时。若日后要原始查询本身达毫秒级，可加分钟级 rollup 表(当前按「不新增存储」取舍未做)。

### `GET /v1/installs`
实例明细(按 last_seen 倒序)。
```jsonc
{ "ok": true, "data": { "installs": [
  { "installId": "...", "user": "user018", "host": "HOST-018",
    "platform": "win32", "appVersion": "1.2.9", "channel": "packaged",
    "firstSeen": "2026-06-05T03:22:49.985Z", "lastSeen": "...", "liveSessions": 2 }
] } }
```

---

## CSV 导出 `GET /v1/export/*`

四个端点与看板同源同口径，鉴权与 `/v1/stats/*` 一致（登录即可）。响应 `Content-Type: text/csv; charset=utf-8` + `Content-Disposition: attachment`，正文**中文表头 + UTF-8 BOM**（Excel 直接双击不乱码），数值列导原始整数、格式化交给 Excel。

| 端点 | 参数 | 列 |
|---|---|---|
| `GET /v1/export/blueprints` | `from`/`to`（同 stats，缺省近 30 天） | 工作流·运行·成功·失败run·中止·失败事件·活跃时长ms·中断·输入Token·输出Token·Token合计·**上次活跃·沉默天数** |
| `GET /v1/export/users` | `from`/`to` | 用户·主机·会话数·run数·失败数·活跃时长ms·输入Token·输出Token·Token合计·**上次活跃·沉默天数** |
| `GET /v1/export/failures` | `from`/`to` | 时间·用户·主机·工作流·来源·类型·原因·版本·事件ID |
| `GET /v1/export/installs` | 无（全量快照） | 用户·主机·版本·平台·渠道·活动会话·最后在线·首次上线·实例ID |

- **`failures` 同时含装失败**：`update_apply{ok:false}` 与 `failure_event` 同列，字段口径必须与看板「最近失败」表一致——`来源=auto-update`、`类型=update:<reason>`、`原因=<from> → <to>（第 N 次尝试）`。两端各写一份（浏览器 ESM / Node CJS 无共享层），**改一处必须同步改 `public/js/features/failures.js::renderRecent`**，否则同一批数据导出与看板对不上。
- **`blueprints`/`users` 含沉默实体**：两者与看板走**同一段装配代码**（`lib/stats.js::assembleBlueprints` / `assembleUsersAll`），因此区间内零活动的沉默工作流（过准入线的）与沉默用户会一并导出，准入线挡掉的同样不导出——「导出与看板同口径」这条纪律靠共享装配兜住，不靠两份实现自觉对齐。`上次活跃`/`沉默天数` 无记录时**留空**（不是 0——0 的含义是「今天用过」）。
- **安全上限**：`failures` 单次最多 10 万行，命中即 `[export]` 日志提示可能截断（缩小 `from`/`to` 重导）。其余端点读 `daily_*` 小表，无上限。
- 范围非法（非 `YYYY-MM-DD`、倒置、跨度 >400 天）→ `400 {ok:false,error:'bad range'}`（JSON，非 CSV）。

---

## 应用自动更新 `/v1/update/*`

客户端设计权威源：TechDemos `docs/APP-AUTO-UPDATE-DESIGN.md`（§5 契约、§7 服务端设计）。
存储在文件系统 `releases/`（`OPS_RELEASES_DIR` 可改），清单落 `index.json`——与遥测库解耦，救急可直接 `cat`/手改。

**产品维度** `?product=`（缺省 `cancong`，现有客户端 / 看板零感知；TechDemos `docs/EVOLVE-SERVICE-SPLIT-DESIGN.md` §5.6）：所有 `/v1/update/*` 路由都可带 `product`。
`evolve` = 自进化服务 cancong-evolve 的 Linux 预构建包：**独立的版本号 / `index.json` / 发布区**（`releases/evolve/`），变体 `linux-x64`（必需）/ `linux-arm64`（可选），
规范名 `cancong-evolve-<ver>-linux-<arch>.tar.gz`，不派生解压道，不进蚕丛的 manifest。未知产品 → 400。看板「版本发布」页顶部切换（`#release/evolve`）。

### 免鉴权（与 `POST /v1/events` 同档：客户端没有账号，内网即信任）

**`GET /v1/update/latest[?current=<本机版本>]`** — 有已发布版本 → `200`：

```jsonc
{
  "schemaVersion": 1,
  "version": "0.0.4",
  "pubDate": "2026-08-05T10:00:00.000Z",
  "notes": "…管理员填写的更新说明…",
  "minSupported": "",              // 空串 = 不设版本地板（默认）；非空则低于此版本的客户端被阻断
  "packages": {
    "slim":       { "file": "cancong-portable-0.0.4.exe",            "size": 115434858, "sha256": "…64hex…" },
    "with-linux": { "file": "cancong-portable-0.0.4-with-linux.exe", "size": 273685960, "sha256": "…64hex…" }
  }
}
```

尚无已发布版本 → `204 No Content`（不是 404，避免与路由错误混淆）。客户端只认 `packages[variant].file`，绝不自己拼文件名。

`current`（可选）是客户端自报的真实版本（`app.getVersion()`）。合法三段数字且 **≥ 已发布版本** → 直接 `204`，服务端替它闭嘴；非法串、空值、缺省，或已发布版本号本身不合法（`index.json` 被手改坏）→ 一律照常返回 manifest（**fail-open**：绝不因为一个查询参数让全公司集体停更）。这道闸是「万一又发出版本号标错的包」时不必等客户端发版就能止住误提示的后手，同时让 access log 里能直接看到客户端的真实版本。老客户端不带此参数，行为不变。

**`GET /v1/update/download/:file`** — `res.sendFile` 原生支持 `Range`（断点续传）。`:file` 须匹配 `/^[A-Za-z0-9._-]+$/` 且命中当前已发布清单，否则 `404`（防路径穿越；已下架版本即刻 404）。

### 鉴权内 + requireAdmin（运维动作——任何人都能推包等于任何人都能给全公司装东西）

| 端点 | 说明 |
|---|---|
| `POST /v1/update/upload?variant=slim\|with-linux\|linux-x64\|linux-arm64&version=<ver>[&filename=]` | body 为 raw octet-stream；边写边算 sha256 落 `staging/<ver>/<variant>.exe`（Linux 变体为 `.tar.gz`）+ 同名 `.json` 边车；同 (ver,variant) 重传直接覆盖（幂等） |
| `GET /v1/update/drafts` | 草稿区各版本各变体就位情况 + 当前已发布 + 可回滚历史（登录即可读，非 admin 也可看） |
| `POST /v1/update/publish` | body `{ version, notes, minSupported }`。服务端自检：①`slim` 与 `with-linux` 两个 exe 齐备（Linux 独立版包 `linux-x64` / `linux-arm64` **可选**，在就一起发）②版本合法三段数字且高于当前已发布 ③大小/sha256 复算与边车一致 ④地板为空或合法且 ≤ version ⑤边车 `originalName` 里内嵌的三段版本号（抽得到才查）与声明 `version` 数值相等 ⑥Linux 包文件头须为 gzip、原名带架构时须与变体一致。Linux 包规范名 `cancong-server-<ver>-linux-<arch>.tar.gz`，不派生解压道；manifest `packages` 只含在场的变体（Windows 客户端只读自己的 key）。通过则 rename 进 `published/<ver>/`（文件名归一为无空格 slug）并重写 `index.json` |
| `POST /v1/update/unpublish` | 下架当前版本（删其文件），回退到上一个文件仍在的已发布版本；没有则清空（`/latest` 回 204） |
| `DELETE /v1/update/draft/:version/:variant` | 删草稿 |

发布区保留最近 **3** 个版本的文件供回滚，更旧自动清理（磁盘规划：3 × ~370MB ≈ 1.2GB，见 README）。

**关于自检 ⑤（包名版本对账）**：`version` 是运维在发布页手输的自由文本，与包内容无关，而 `canonicalName()` 会把文件强行改名成 `cancong-portable-<声明版本>.exe`——发错包（标 0.0.4 实为 0.0.3）不会有任何报错，后果却是所有客户端被告知「有新版本 0.0.4」，升完 `app.getVersion()` 还是 0.0.3，于是**无限提示**（真实事故）。构建产物天然叫 `cancong-portable-<版本>[-with-linux].exe`，上传时的原始文件名已记进边车，拿来对账零成本。抽不到三段版本号（运维自己改过名，如 `build-final.exe`）→ 不拦，保持 fail-open；`0.0.04` 与 `0.0.4` 按数值判等，不误伤。发布页在选文件时也会就地预警，但**真正的把关在这里**。

上传**无尺寸上限**且是分钟级长请求：进程侧已在 `listen` 后关掉 `srv.requestTimeout`（Node 18+ 默认 300s 会把大包截断成 `400 upload aborted`），反向代理需同步放宽（见 [DEPLOYMENT.md §9.1](./DEPLOYMENT.md)）。curl 复现时**不要带 `-H 'content-type: application/json'`**——`express.json` 会先吃掉 body，服务端只看到 `400 empty body`：

```bash
curl -X POST --data-binary @cancong-portable-0.0.4.exe \
  -H 'content-type: application/octet-stream' -H "authorization: Bearer $TOKEN" \
  "http://host:5900/v1/update/upload?variant=slim&version=0.0.4&filename=cancong-portable-0.0.4.exe"
```

### `update_apply` 事件

客户端在升级终局（启动自检判定成功/最终失败）上报，payload：
`{ from, to, variant, ok, attempts, reason? }`（`reason` 仅 `ok:false` 时携带：`sha_mismatch` · `sfx_exit_nonzero` · `sfx_timeout` · `version_mismatch` · `other_instance` · `parent_alive` · `download_failed` · `disk_full` · `unknown`）。
ingest：`ok:false` 计入 `daily_fail`（kind = `update:<reason>`）→ 失败页 kind 分布可见；`ok:true` 只存原始（升级铺开进度看 installs 的 `appVersion` 分布即可）。「最近失败事件」列表同时列出 `update_apply{ok:false}`（响应行带 `type` 字段区分）。

## 服务发现 `GET /v1/discovery`

**免鉴权**（与 `POST /v1/events` 同档）。客户端据此找自进化服务，看板据此决定是否挂「自进化」页签（TechDemos `docs/EVOLVE-SERVICE-SPLIT-DESIGN.md` §4.2）。
由 env `OPS_EVOLVE` 决定：

```
{ "schemaVersion": 1, "services": { "evolve": { "port": 5901 } } }          ← OPS_EVOLVE=:5901（同主机相对）
{ "schemaVersion": 1, "services": { "evolve": { "url": "http://h:5901" } } } ← OPS_EVOLVE=<绝对 URL>
{ "schemaVersion": 1, "services": { "evolve": null } }                       ← 未设（明确没有）
```

`services` 只增键。旧版本服务没有这条路由（门禁先于 404，回 401）——客户端把任何非 200 当「从未拿到」。
自进化样本（`bp_patch_proposal` / `bp_patch_verdict` / `evolve_run_summary`）不再进本服务，来了按未知类型计数。

## 人员（同机 cancong-evolve 用）`GET /v1/internal/persons`

门禁白名单放行，路由内**只认回环来源**（`127.0.0.1` / `::1`），或带对 `X-Ops-Internal-Token: <OPS_INTERNAL_TOKEN>`（非回环部署时）；否则 403。
返回全量实例 `{ ok, data: [{ installId, user, host, welinkUid, lastSeen, appVersion }] }`。需求研发看板（TechDemos `docs/REQ-FLOW-DESIGN.md` §8.2）据此注册「所有蚕丛用户」并判在线（`lastSeen` 10 分钟内）。

## 框架问题 `/v1/fw-issues`

门禁内；响应 `{ ok, data }`。

| 方法 路径 | 权限 | 说明 |
|---|---|---|
| `GET /v1/fw-issues?limit&offset` | 登录 | 签名排名（回归置顶）：次数 / 报告数 / 机器数（`fw_issue_machines` 去重）/ 事后通过 / 修复与回归版本 |
| `POST /v1/fw-issues/:sig/fixed` | admin | `{version:'x.y.z'}` 标「已修复于」（空串 = 清除）；之后 ≥ 该版本的客户端再报 ⇒ `regressedVersion`；非法版本 400、无此签名 404 |

上报整批可带 `Content-Encoding: gzip`（`express.json` 默认解压，1MB 上限按解压后计）。

## 错误响应

| 状态码 | 场景 | body |
|--------|------|------|
| `400` | 批非数组 / >500 条 | `{ ok:false, error:"bad batch" }` |
| `400` | from/to 非法、倒置、跨度 >400 天 | `{ ok:false, error:"bad range" }` |
| `400` | `/stats/users/top` metric 非白名单 | `{ ok:false, error:"bad metric" }` |
| `400` | `/stats/blueprints/series` 缺 `id` 或 id 空/超 256 | `{ ok:false, error:"bad id" }` |
| `400` | `/stats/users/series` 缺 `user` 或 `host` | `{ ok:false, error:"bad user/host" }` |
| `413` | body 超 1 MB | `{ ok:false, error:"bad request" }` |
| `404` | `/v1` 下未知路由 | `{ ok:false, error:"not found" }` |
| `500` | ingest/stats 内部异常 | `{ ok:false, error:"..." }` |

所有错误均为 JSON，不裸崩。客户端上报遵循 **fail-open**：任何非 2xx 或超时都应静默降级 + 落 spool 重试，绝不影响主流程。
