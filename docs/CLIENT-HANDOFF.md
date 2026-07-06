# cancong 采集端实现 & 联调 Handoff

> 面向：在 **蚕丛 harness 仓库（TechDemos）** 实现遥测采集模块 `server-telemetry/` 的开发者。
> 服务器端 **cancong-ops 已实现到 v0.3.0**（ingest + 存储聚合 + stats API + 看板 + 实时视图），本仓库即契约来源。
> 本次工作 = 设计文档里程碑 **M3（客户端采集）**：让 harness 按契约把事件打到 cancong-ops，并联调打通看板。

契约权威文件（本仓库）：[docs/API.md](./API.md)（信封 + 端点）、[OPS-TELEMETRY-DESIGN.md](../OPS-TELEMETRY-DESIGN.md) §5/§6（客户端设计）。本 Handoff 是二者的落地清单，若有出入以 **API.md + 服务器代码** 为准。

---

## 1. 一句话目标

在 harness 生命周期的若干挂接点，构造统一信封事件 → 批量 `POST /v1/events` 到 cancong-ops → 看板即可见使用人数/会话/工作流/失败/Token/实时活动。**铁律：fail-open**（服务器不可达绝不影响 harness 主流程）。

---

## 2. 传输契约（服务器已实现，客户端必须遵守）

| 项 | 约定 |
|----|------|
| 端点 | `POST {endpoint}/v1/events` |
| 请求体 | `{ "events": [ <envelope>, ... ] }` |
| 单批上限 | **≤ 500 条**（超过整批 `400 bad batch`） |
| body 上限 | **≤ 1 MB**（超过 `413`） |
| 成功响应 | `200 { ok:true, accepted, dup, rejected? }` |
| 健康检查 | `GET {endpoint}/healthz → {ok:true}` |
| 鉴权 | **无**——上报接口 `POST /v1/events` 开放（内网即信任），采集端无需登录或带 token。仅 web 看板需登录（不影响采集端接入） |

- **幂等**：服务器按 `eventId` 去重（`INSERT OR IGNORE`）。客户端**每个事件生成一次稳定 `eventId`（uuid），重发时复用同一个** → 断网补发天然安全，无需精确一次投递。`accepted`=首次入库数，`dup`=被去重数，`rejected`=结构非法被跳过数。
- **非法事件不整批拒绝**：单条缺字段/超长只跳过自己（计入 `rejected`），其余照收。但客户端应尽量发合规事件。
- **fail-open**：任何非 2xx / 超时 / 异常 → 静默降级（仅 debug 日志）+ 落 spool 重试。镜像 `server.js::fetchOpencodeLatestVersion()`（内置 https、8s 超时、失败即弃）。

---

## 3. 事件信封（双端唯一契约）

```jsonc
{
  "schemaVersion": 1,              // 必填，严格 === 数字 1（"1" 字符串会被拒）
  "eventId": "uuid",               // 必填，非空 ≤128；幂等去重键，重发复用
  "type": "session_start",         // 必填，非空 ≤64；见 §4
  "ts": "2026-07-04T09:30:00+08:00", // 选填，客户端本地时刻(ISO)；仅留档，聚合以服务器接收时刻为准
  "installId": "uuid",             // 必填，非空 ≤128；见 §6 identity
  "user": "zhangsan",              // 必填，非空 ≤256；os.userInfo().username
  "host": "DESKTOP-XXXX",          // 必填，非空 ≤256；os.hostname()
  "platform": "win32",             // 推荐，process.platform
  "appVersion": "1.4.0",           // 推荐，package.json version（版本分布/失败率按此）
  "channel": "packaged",           // 推荐，packaged | dev（看板过滤开发噪声）
  "bootId": "uuid",                // 选填，每进程启动生成
  "payload": { }                   // type 专属，见 §4
}
```

**必填 5 字段 + schemaVersion** 不满足 → 该事件被 `rejected`。`appVersion`/`channel`/`platform` 强烈建议带（否则版本分布、渠道过滤失效）。

---

## 4. 事件类型与 payload（★ = v0.2/v0.3 服务器已消费、需客户端新采集的字段）

| type | 触发点 | payload |
|------|--------|---------|
| `instance_online` | 实例上线 | `{ port, liveSessions }` |
| `instance_heartbeat` | 定时 5min±抖动 | `{ liveSessions }` |
| `session_start` | 会话开始 | `{ tool, cwdHash }` |
| `session_end` | 会话结束 | `{ tool, durationMs, exitCode, `**`inputTokens★, outputTokens★`**` }` |
| `bp_run_start` | 工作流 run 新建 | `{ blueprintId, runId, tool }` |
| `bp_run_end` | 工作流 run 终态 | `{ blueprintId, runId, status, activeMs, haltReason?, `**`interruptions★, inputTokens★, outputTokens★`**` }` |
| `failure_event` | 异常信号 | `{ source, kind, reason, tool, runId?, `**`blueprintId★`**` }` |

**逐事件示例**（payload 部分）：
```jsonc
// session_start
{ "tool": "claude", "cwdHash": "abcdef012345" }        // cwdHash = sha256(规范化 cwd).slice(0,12)
// session_end —— tokens = 本次会话累计输入/输出 token（token 总量权威）
{ "tool": "claude", "durationMs": 3600000, "exitCode": 0, "inputTokens": 128400, "outputTokens": 31200 }
// bp_run_start
{ "blueprintId": "ship-it", "runId": "r-uuid", "tool": "claude" }
// bp_run_end —— tokens = 本 run 消耗（会话子集）；interruptions = 运行中用户打断次数
{ "blueprintId": "ship-it", "runId": "r-uuid", "status": "done", "activeMs": 240000,
  "interruptions": 2, "inputTokens": 90000, "outputTokens": 12000 }              // status ∈ done|failed|halted
// failure_event —— blueprintId 带上则失败归因到具体工作流
{ "source": "error_autoresume", "kind": "rate_limit", "reason": "...", "tool": "claude",
  "runId": "r-uuid", "blueprintId": "ship-it" }
```

**口径要点（客户端只管如实上报，分流是服务器的事）**：
- `session_end` 的 token = **会话总量权威**（服务器记为总量）；`bp_run_end` 的 token = **该 run 子集**（服务器归到工作流维度）。二者服务器分别聚合、互不重复求和——**客户端两处都按各自实际值报即可，不要自己去重/相减**。
- 数值字段（`durationMs/activeMs/inputTokens/outputTokens/interruptions/liveSessions`）：**非负整数**。服务器会把负数/非数净化为 0，但客户端应发干净值。
- `status` 只认 `done|failed|halted`；其它值服务器不计入 run 终态。
- `bp_run_start` 只落原始不聚合（run 计数以终态为准，避免跨日双计）——客户端照发即可。
- 隐私红线（v1）：**不上传** cwd 明文 / prompt / 会话内容 / 代码。`cwdHash` 仅哈希前缀。`blueprintId` 是内部工作流名，可上传。

---

## 5. ★新增字段的数据来源（本次客户端最需要打通的三处，需在 harness 核实/实现）

这三类是 v0.2/v0.3 服务器新消费、原 harness 未采集的，**是本次采集端的核心开发点**：

1. **Token（session_end / bp_run_end 的 inputTokens/outputTokens）**
   - 来源：harness 调模型 API 的响应 usage（input/output tokens）。需在会话/run 维度**累加**每次调用的 usage。
   - 实现建议：在会话上下文与 run 上下文各挂一个 token 累加器，会话结束/ run 终态时读出。
   - ⚠️ 需核实：harness 现有代码在哪里能拿到每次调用的 token usage（模型响应对象/流式结束事件）。这是最需要先摸清的点。

2. **interruptions（bp_run_end 的用户中断次数）**
   - 语义：run 运行过程中用户插话/打断的次数（「用户中断」，非 halted 终态）。
   - 来源信号：设计文档 §9.2 指出 harness 有 `detectIntervention()`（`server-blueprint/memory/recorder.js:80` 一带，NEG_RE 负向措辞/中途插话检测）。在 run 生命周期内对该信号计数，终态时随 `bp_run_end` 上报。
   - ⚠️ 需核实：detectIntervention 的触发时机是否等价于"用户打断一次 run"。

3. **blueprintId（failure_event 归因）**
   - 语义：失败发生在哪个工作流 run 内。带上则失败在看板归因到具体工作流。
   - 来源：失败发生时若处于某 run 上下文，取当前 runId 对应的 blueprintId 一并带上；不在 run 内则不带（服务器仍计入总量失败，只是不归因工作流）。

> 说明：**v0.3 的「实时视图」不需要客户端新增任何字段**——它只是把已有事件按分钟直查呈现。客户端把上述事件正常发出即可，实时页自动有数据。仅需注意：服务器按**接收时刻**分桶，30s 批量 flush 会让实时分钟桶有 ≤30s 延迟（可接受；若要更实时可调小 flush 间隔）。

---

## 6. 客户端模块结构与挂接点（设计文档 §6.1 / §6.2）

建议模块（`server-telemetry/`）：
```
index.js       createTelemetry(ctx) → { emit(type, payload), shutdown() }；总开关判定
identity.js    installId 读写 + user/host/version/channel 采集（见 §5 设计文档：installId 持久化 DATA_ROOT/telemetry/install.json）
collect.js     各挂接点适配 + 限流（failure_event 每小时 cap 30/实例）
spool.js       DATA_ROOT/telemetry/spool.jsonl：失败落盘、上限 10MB 丢最旧、恢复补发
sender.js      内存队列 + 30s 批量 flush（≤500/批）+ 心跳定时器；https POST，8s 超时，fail-open
__tests__/     node --test，本地 stub HTTP server，零外网
```

挂载遵循既有 `server-xxx/` 惯例：`onListening()` 成功后初始化单例 `telemetry`，各挂接点显式 `telemetry.emit(type, payload)`。**不新增 WS 通道/前端桥**。

**挂接点（行号为设计文档参考值，实现时逐点核实）**：

| 事件 | 挂接位置（harness / TechDemos） |
|------|------|
| instance_online / heartbeat | `onListening()`（server.js:7098 一带）：上线发一条 + 启动 5min 心跳定时器 |
| session_start | `spawnAndAttach()` 内 pty.spawn 成功、startedAt 落定处（server.js:6599 一带） |
| session_end | `child.onExit()`（server.js:6928 一带）：durationMs = now − startedAt；**在此读会话 token 累加器** |
| bp_run_start | `launchRun()` 新建 run 分支（server-blueprint/routes.js:651 一带）；续跑不重发（按 runId 判新建） |
| bp_run_end | **state 写入收敛点检测终态跃迁**（prev.status → done/failed/halted 时 emit，runId 去重）；终态写点分散（routes.js:1022/2075/2377/2483、chain-engine.js、engine.js:748/779），在 state-io 写入口单点检测最稳；**在此读 run token 累加器 + interruptions 计数** |
| failure_event | error-autoresume `_emit()`（error-autoresume.js:210 一带）旁挂分类结果；**带上当前 run 的 blueprintId**；`source ∈ error_autoresume / halt / stall_patrol`；每小时限流 30/实例 |

---

## 7. 开关与配置（设计文档 §6.3，三层门控）

| 层 | 键 | 行为 |
|----|-----|------|
| env 强关 | `HARNESS_TELEMETRY=0`（进 server-config/env-registry.js） | 一键全关；**ST/CI 必须置 0**（不污染数据、不新增 ST 观测面） |
| settings 开关 | `settings.telemetryEnabled`（默认 true） | 走既有 profiles.json → `/api/settings` → global-settings.js 面板 checkbox，UI 文案「使用统计上报」 |
| endpoint | `HARNESS_TELEMETRY_ENDPOINT` env ▷ `settings.telemetryEndpoint` ▷ 代码内 DEFAULT 常量 | endpoint 为空 = 天然关闭；开发态默认常量留空，发布构建/env 注入内网地址 |

---

## 8. 可靠性（设计文档 §6.4，sender/spool 行为）

- 事件 → 内存队列（上限 5000，超限丢最旧）→ 每 **30s** 批量 `POST`（**≤500/批**）。
- 发送失败 → 整批追加 `spool.jsonl`；下轮 flush **先补发 spool 再发新事件**；spool 超 **10MB** 截断最旧。
- 心跳独立定时器 **5min ± 30s 抖动**（摊平千实例早高峰同刻上报）。
- `shutdown()`：进程退出前尽力 flush 一次（**不阻塞退出，500ms 上限**）。
- eventId 幂等：补发/重发由服务器 `INSERT OR IGNORE` 去重，客户端无需精确一次。

---

## 9. 联调步骤（端到端打通）

**准备**：本仓库 `npm ci && npm start` 起本地 cancong-ops（默认 `http://localhost:5900`）。确认 `curl localhost:5900/healthz → {ok:true}`。

1. **配 harness 客户端指向本地 server**：`HARNESS_TELEMETRY_ENDPOINT=http://localhost:5900`，确保 `HARNESS_TELEMETRY≠0` 且 `settings.telemetryEnabled=true`。
2. **跑 harness**：启动 → 开若干会话 → 跑几个工作流（含成功/失败/中止）→ 故意触发一次失败 → 让其中一个 run 被用户打断。
3. **逐端点验证数据流**（curl 或看板）：
   - `curl 'localhost:5900/v1/stats/overview'` → 今日会话/run/失败/**Token(入/出)** 有值。
   - `curl 'localhost:5900/v1/stats/blueprints'` → 各工作流 runs/失败/**activeMs/interruptions/token** 有值，失败归因到工作流。
   - `curl 'localhost:5900/v1/stats/users/top?metric=tokens'` → 你的 user@host 在列，token 非 0。
   - `curl 'localhost:5900/v1/stats/realtime?window=60'` → 最近几分钟有分钟桶（events/sessions/tokens/activeUsers）。
   - 浏览器开 `localhost:5900` → 概览/趋势(切「实时」)/工作流/用户/失败 六页真数据可视。
4. **验幂等**：把同一批事件再 POST 一次 → 响应 `dup` 增大、`accepted=0`，看板数值不变（不双计）。
5. **验 fail-open**：停掉 cancong-ops → harness 继续正常工作（主流程零影响）→ 事件落 spool → 重启 cancong-ops → 下轮 flush 补发，看板补齐。
6. **验限流**：短时间制造 >30 次失败/小时 → 客户端应 cap 到 30，看板失败数不超采。

**观测点**：server 端 ingest 异常打 `[ingest]`；客户端 fail-open 走 debug 日志。`/v1/stats/*` 任何 400 说明批/字段不合规（对照 §2/§3）。

---

## 10. 验收清单（M3 完成判据）

- [ ] 六页看板在真实 harness 使用下都有数据，口径与实际对得上。
- [ ] Token：session_end 报会话总量、bp_run_end 报 run 子集，概览/趋势/用户/工作流 token 合理。
- [ ] interruptions / blueprintId 归因在工作流页与失败页正确体现。
- [ ] 实时页近 24h 分钟趋势随 harness 活动实时变化（≤30s 延迟）。
- [ ] 断网/停服零影响主流程；恢复后 spool 补发不丢不重（dup 去重生效）。
- [ ] `HARNESS_TELEMETRY=0` 与 endpoint 留空均能一键静默；ST fixtures 统一置 0。
- [ ] `server-telemetry/__tests__/` node --test 全绿（本地 stub server，零外网）；`npm run st` 不回归。

---

## 11. 服务器端参考指针（本仓库）

- 契约与端点：[docs/API.md](./API.md)（信封字段、7+2 端点、错误码、Token 防双计说明）。
- 架构与存储：[docs/ARCHITECTURE.md](./ARCHITECTURE.md)（schema、聚合去向、实时直查路径）。
- 校验实现：`lib/ingest.js`（`validate()`、批/体上限、增量映射 `deltasOf()`、工作流/失败归因）。
- 事件如何落聚合：`lib/db.js`（`bumpDaily`/`bumpDailyBlueprint`/`bumpDailyFail`；token 分流 daily_user vs daily_blueprint）。
- 本地造数参照：`scripts/seed-demo.js`（各事件含新字段的构造范例，可直接抄 payload 形状）。
