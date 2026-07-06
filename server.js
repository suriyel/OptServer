'use strict';
// server.js —— cancong-ops 入口：Express 单进程装配 + 生命周期。
//
// 装配顺序（语义即注释）：
//   json body(1mb) → /healthz（门禁之前，探活永不受鉴权影响）
//   → 全局门禁 createAuthGate（只保护看板：未登录页面→302 login.html、受保护 /v1→401；
//     白名单含 POST /v1/events 采集上报、/healthz、/login.html、/v1/auth/login；含 static）
//   → /v1 auth 路由（/auth/login 由门禁白名单放行）→ ingest / stats / export 路由
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
// 时区不做 env：day 归日依赖部署机 TZ（systemd 单元钉 TZ=Asia/Shanghai）。

const path = require('path');
const express = require('express');

const { openDb } = require('./lib/db');
const { createIngestRouter } = require('./lib/ingest');
const { createStatsRouter } = require('./lib/stats');
const { createExportRouter } = require('./lib/export');
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

  app.use(express.static(path.join(__dirname, 'public')));
  app.use('/v1', (req, res) => res.status(404).json({ ok: false, error: 'not found' }));

  // 错误兜底：含 express.json 的解析错误（400/413 带 err.status），其余一律 500
  app.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
    const status = err.status || err.statusCode || 500;
    console.log('[server] error', status, String(err.message));
    res.status(status).json({ ok: false, error: status >= 500 ? 'server error' : 'bad request' });
  });

  return { app, db, dao, close };
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
  const { app, dao, close } = createApp({});
  // 夜间 job 只在真实进程挂载（测试 require createApp 不带调度器）
  const { startScheduler } = require('./lib/aggregate');
  const scheduler = startScheduler(dao, {
    retentionDays: Number(process.env.OPS_RETENTION_DAYS) || 90,
  });
  const port = Number(process.env.PORT) || 5900;
  const srv = app.listen(port, () => {
    console.log('[server] cancong-ops listening on', srv.address().port);
  });
  for (const sig of ['SIGINT', 'SIGTERM']) {
    process.on(sig, () => {
      console.log('[server] shutdown on', sig);
      gracefulShutdown(scheduler, srv, close);
    });
  }
}

module.exports = { createApp, gracefulShutdown };
