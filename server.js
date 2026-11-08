'use strict';
// server.js —— cancong-ops 入口：Express 单进程装配 + 生命周期。
//
// 装配顺序（语义即注释）：
//   json body(1mb) → /healthz（门禁之前，探活永不受鉴权影响）
//   → 全局门禁 createAuthGate（只保护看板：未登录页面→302 login.html、受保护 /v1→401；
//     白名单含 POST /v1/events 采集上报、GET /v1/config/evolve 自进化配置拉取、/healthz、/login.html、/v1/auth/login；含 static）
//   → /v1 auth 路由（/auth/login 由门禁白名单放行）→ ingest / stats / export / update / 自进化配置 / 自进化中心路由
//   → public/ 静态看板（仅登录后可达）→ /v1 JSON 404 → 错误兜底。
//
// env（README 有表）：
//   PORT                监听端口，默认 5900（设计文档 §7.1）
//   OPS_DB_PATH         SQLite 路径，默认 ./data/ops.db（目录自动创建）
//   OPS_RETENTION_DAYS  events 原始表保留天数，默认 90
//   OPS_ADMIN_USER      预置管理员用户名，默认 admin（仅首次无 admin 时生效）
//   OPS_ADMIN_PASSWORD  预置管理员初始密码，缺省 admin123（用默认时启动打印告警）
//   OPS_SESSION_DAYS    登录会话有效期天数，默认 7
//   OPS_SECURE_COOKIE   =1 时会话 Cookie 带 Secure（HTTPS 部署用），默认关
//   OPS_RELEASES_DIR    应用更新发布区目录，默认 ./releases（磁盘规划见 README：3 版本 ≈ 1.2GB）
//   OPS_CANCONG_URL     自进化中心回环调用的同机蚕丛独立版地址，默认 http://127.0.0.1:5599
//   OPS_EVOLVE_WORK_DIR 自进化中心批处理工作目录，默认 <OPS_DB_PATH 同级>/evolve-work（须蚕丛进程可读写）
//   OPS_CANCONG_TOOL    中心 run 用的蚕丛工具 id（如 opencode / claude），缺省 = 蚕丛自己的缺省工具
// 安装包上传是分钟级长请求，listen 后关掉 srv.requestTimeout（见文件末）。
// 时区不做 env：day 归日依赖部署机 TZ（systemd 单元钉 TZ=Asia/Shanghai）。

const path = require('path');
const express = require('express');

const { openDb } = require('./lib/db');
const { createIngestRouter } = require('./lib/ingest');
const { createStatsRouter } = require('./lib/stats');
const { createExportRouter } = require('./lib/export');
const { createUpdateRouter } = require('./lib/update');
const { createEvolveConfigRouter } = require('./lib/evolve-config');
const { createEvolveCenterRouter } = require('./lib/evolve-center');
const { createCancongClient } = require('./lib/center/cancong-client');
const { createRunner } = require('./lib/center/runner');
const { createBasket } = require('./lib/center/basket');
const { seedAdmin, createAuthGate, createAuthRouter } = require('./lib/auth');

function createApp(opts) {
  opts = opts || {};
  const dbPath = opts.dbPath || process.env.OPS_DB_PATH || path.join(__dirname, 'data', 'ops.db');
  const nowFn = opts.nowFn || (() => new Date());
  const authGate = opts.authGate !== false; // 默认开启（生产鉴权）；测试夹具显式关闭以兼容旧用例
  const { db, dao, close } = openDb(dbPath);
  seedAdmin(dao, { adminUser: opts.adminUser, adminPassword: opts.adminPassword, nowFn });

  const app = express();
  app.use(express.json({ limit: '1mb' })); // ≤500 事件/批 × ~1KB ≈ 500KB，2 倍余量

  app.get('/healthz', (req, res) => res.json({ ok: true })); // 门禁前，探活永不受鉴权影响

  if (authGate) app.use(createAuthGate(dao, { nowFn })); // 全局门禁（含 static）；将来改鉴权只动这里与 lib/auth.js
  app.use('/v1', createAuthRouter(dao, { nowFn }));       // /auth/login(门禁放行) /auth/me /auth/users ...
  app.use('/v1', createIngestRouter(dao, { nowFn }));
  app.use('/v1', createStatsRouter(dao, { nowFn }));
  app.use('/v1', createExportRouter(dao, { nowFn })); // 须在 static / /v1 404 之前
  // 应用自动更新发布面（latest/download 免鉴权经门禁白名单；upload 是 octet-stream raw
  // stream——express.json 只拦 application/json，不会吃掉它的 body）
  app.use('/v1', createUpdateRouter({ releasesDir: opts.releasesDir || process.env.OPS_RELEASES_DIR, nowFn }));
  // 蓝图自进化上报配置（GET 免鉴权经门禁白名单；PUT requireAdmin）
  app.use('/v1', createEvolveConfigRouter(dao, { nowFn }));
  // 自进化中心（五页签 + 队列 + 篮子）：回环调同机蚕丛（设计 §5.1；调度器在 require.main 分支挂）
  const cancong = createCancongClient({ baseUrl: opts.cancongUrl, tool: opts.cancongTool });
  const runner = createRunner(dao, cancong, {
    nowFn, pollMs: opts.evolvePollMs, centerBlueprintDir: opts.centerBlueprintDir,
    workDir: opts.evolveWorkDir || process.env.OPS_EVOLVE_WORK_DIR
      || path.join(path.dirname(path.resolve(dbPath)), 'evolve-work'),
  });
  const basket = createBasket(dao, cancong, { nowFn });
  app.use('/v1', createEvolveCenterRouter(dao, { nowFn, runner, basket }));

  app.use(express.static(path.join(__dirname, 'public')));
  app.use('/v1', (req, res) => res.status(404).json({ ok: false, error: 'not found' }));

  // 错误兜底：含 express.json 的解析错误（400/413 带 err.status），其余一律 500
  app.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
    const status = err.status || err.statusCode || 500;
    console.log('[server] error', status, String(err.message));
    res.status(status).json({ ok: false, error: status >= 500 ? 'server error' : 'bad request' });
  });

  return { app, db, dao, close, runner };
}

// 优雅退出：先停调度器 → srv.close 等既有连接收尾后关库退出 →
// 3s 兜底强退（systemd Restart 场景不吊死）。抽出为可测函数（注入 exitFn/timeoutMs）。
function gracefulShutdown(scheduler, srv, close, exitFn, timeoutMs) {
  const exit = exitFn || ((code) => process.exit(code));
  const ms = timeoutMs == null ? 3000 : timeoutMs;
  let done = false;
  const finish = () => { if (done) return; done = true; close(); exit(0); };
  scheduler.stop();
  srv.close(finish);
  const t = setTimeout(finish, ms);
  if (t.unref) t.unref();
}

if (require.main === module) {
  const { app, dao, close, runner } = createApp({});
  // 夜间 job 只在真实进程挂载（测试 require createApp 不带调度器）
  const { startScheduler } = require('./lib/aggregate');
  const nightly = startScheduler(dao, {
    retentionDays: Number(process.env.OPS_RETENTION_DAYS) || 90,
  });
  // 自进化队列每日窗口（默认 02:00，配置页可改；异步 job，单飞在 runner 里）
  const evolve = require('./lib/center/scheduler').startEvolveScheduler(dao, runner);
  const scheduler = { stop() { nightly.stop(); evolve.stop(); } };
  const port = Number(process.env.PORT) || 5900;
  const srv = app.listen(port, () => {
    console.log('[server] cancong-ops listening on', srv.address().port);
  });
  // 安装包上传（POST /v1/update/upload，with-linux 变体 ~370MB）会撞上 Node 18+ 默认的
  // requestTimeout=300s：慢链路上传到一半被掐断 → req 'aborted' → 400 'upload aborted'。
  // 整请求超时关掉；headersTimeout 保留（慢头攻击仍被挡住）。
  srv.requestTimeout = 0;
  srv.headersTimeout = 60_000;
  for (const sig of ['SIGINT', 'SIGTERM']) {
    process.on(sig, () => {
      console.log('[server] shutdown on', sig);
      gracefulShutdown(scheduler, srv, close);
    });
  }
}

module.exports = { createApp, gracefulShutdown };
