# cancong-ops API 契约

> 双端唯一契约。客户端(遥测上报)与看板(数据消费)都以本文件为准。
> 所有响应统一 `{ ok: boolean, ... }`；成功查询为 `{ ok: true, data: {...} }`，失败为 `{ ok: false, error: "..." }`。
> Base URL 默认 `http://<host>:5900`。当前不鉴权(内网即信任)，`/v1` 下预留空 `authMiddleware` 挂点。

## 目录

- [上报接口 `POST /v1/events`](#上报接口-post-v1events)
  - [事件信封](#事件信封envelope)
  - [事件类型与 payload](#事件类型与-payload)
- [健康检查 `GET /healthz`](#健康检查-get-healthz)
- [查询接口 `GET /v1/stats/*`](#查询接口-get-v1stats)
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
  "ts": "2026-07-02T09:30:00+08:00", // 客户端本地时刻(ISO)，仅留档；聚合以服务器接收时刻为准
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

### 事件类型与 payload

> **术语**：本文档中「工作流」= 内部字段 `blueprintId`（事件类型 `bp_run_*` 沿用既有契约名，不改）。

| type | 触发点 | payload | 聚合去向 |
|------|--------|---------|---------|
| `instance_online` | 实例上线 | `{ port, liveSessions }` | 刷 installs.live_sessions；建当日行(计数 0) |
| `instance_heartbeat` | 定时 5min | `{ liveSessions }` | **不落 events**；hb_seen 去重后 `daily_user.heartbeats+1` |
| `session_start` | 会话开始 | `{ tool, cwdHash }` | `daily_user.sessions+1`、`daily_tool.sessions+1` |
| `session_end` | 会话结束 | `{ tool, durationMs, exitCode, inputTokens, outputTokens }` | `session_ms += durationMs`；**`daily_user.in/out_tokens += tokens`(token 总量权威)** |
| `bp_run_start` | 工作流 run 新建 | `{ blueprintId, runId, tool }` | **只落 events 不聚合**(run 计数以终态为准，避免跨日双计) |
| `bp_run_end` | 工作流 run 终态 | `{ blueprintId, runId, status, activeMs, haltReason?, interruptions, inputTokens, outputTokens }` | daily_user 按 `status` 落 `runs_*` + `run_active_ms`；**`daily_blueprint` 落 runs/active_ms/interruptions/token(工作流归因)** |
| `failure_event` | 异常信号 | `{ source, kind, reason, tool, runId?, blueprintId? }` | `daily_user.failures+1`、`daily_fail(day,version,kind)+1`；**带 `blueprintId` 则 `daily_blueprint.failures+1`** |

**v0.2.0 新增 payload 字段**（客户端上报；缺失按 0 / 不归因，服务器 graceful）：
- `session_end.inputTokens` / `outputTokens`（int ≥0）：**会话级 token = 总量权威**，进 `daily_user`（概览/趋势/Top 用户）。
- `bp_run_end.inputTokens` / `outputTokens`（int ≥0）：**run 级 token = 工作流归因子集**，进 `daily_blueprint`（工作流页）。
- `bp_run_end.interruptions`（int ≥0）：运行中用户插话/打断次数（「用户中断」）。
- `failure_event.blueprintId`（string，可选）：把失败归因到具体工作流；缺失则仅计入总量失败，不归因工作流。

> **Token 防重复计数**：会话含多个 run，run token 是会话 token 子集。故会话 token 与 run token 分别进 `daily_user` 与 `daily_blueprint` 两个视图，各自求和、互不重复（`sum(工作流 token) ≤ sum(总量 token)`，非 run 活动不计入工作流）。

- **未知 type**(v2 前向兼容)：结构合格即落 events 原始表、**不做任何聚合**、计入 `accepted`。旧服务器遇新客户端不丢数据。
- **数值净化**：`durationMs`/`activeMs`/`liveSessions`/`inputTokens`/`outputTokens`/`interruptions` 仅当为正有限数才计入，否则按 0。
- **隐私约定(v1)**：不上传 cwd 明文、prompt、会话内容；`cwdHash` 为 sha256 前缀，仅用于项目数统计。

---

## 健康检查 `GET /healthz`

```jsonc
GET /healthz → 200 { "ok": true }
```
挂在鉴权之前，探活永不受未来鉴权影响。

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
  "outTokensToday": 31200
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
高频用户 Top N。`metric` ∈ `sessions｜runs｜failures｜sessionMs｜tokens`(默认 `sessions`；非法值 `400 bad metric`)；`limit` 默认 10、上限 100。服务器按 `metric` 排序返回，前端切换 metric 即重查。
```jsonc
{ "ok": true, "data": { "from": "...", "to": "...", "metric": "tokens", "users": [
  { "user": "user025", "host": "HOST-025", "sessions": 39, "runs": 23, "failures": 6,
    "sessionMs": 80527678, "inTokens": 900453, "outTokens": 173400, "tokens": 1073853 }
] } }
```

### `GET /v1/stats/blueprints?from&to`
各工作流(内部 blueprintId)的运行/失败/E2E/中断/token，按 run 总数倒序。
```jsonc
{ "ok": true, "data": { "from": "...", "to": "...", "blueprints": [
  { "blueprintId": "fix-tests", "runsDone": 82, "runsFailed": 26, "runsHalted": 23, "runs": 131,
    "failures": 39, "activeMs": 37766873, "interruptions": 136,
    "inTokens": 1294296, "outTokens": 262175, "tokens": 1556471 }
] } }
```
- `runs` = done+failed+halted；`failures` = 归因到本工作流的 `failure_event` 数(带 blueprintId)。
- `activeMs` 为「E2E 活跃时长」口径(累加 bp_run_end.activeMs)；`interruptions` 为运行中用户中断次数。

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

## 错误响应

| 状态码 | 场景 | body |
|--------|------|------|
| `400` | 批非数组 / >500 条 | `{ ok:false, error:"bad batch" }` |
| `400` | from/to 非法、倒置、跨度 >400 天 | `{ ok:false, error:"bad range" }` |
| `400` | `/stats/users/top` metric 非白名单 | `{ ok:false, error:"bad metric" }` |
| `413` | body 超 1 MB | `{ ok:false, error:"bad request" }` |
| `404` | `/v1` 下未知路由 | `{ ok:false, error:"not found" }` |
| `500` | ingest/stats 内部异常 | `{ ok:false, error:"..." }` |

所有错误均为 JSON，不裸崩。客户端上报遵循 **fail-open**：任何非 2xx 或超时都应静默降级 + 落 spool 重试，绝不影响主流程。
