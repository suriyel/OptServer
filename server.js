'use strict';
// server.js —— cancong-ops 入口：Express 单进程装配 + 生命周期。
//
// 装配顺序（语义即注释）：
//   json body(1mb) → /healthz（auth 之前，探活永不受未来鉴权影响）
//   → /v1 authMiddleware 空实现（Q8：内网不鉴权；将来加 token 只改这一处）
//   → ingest / stats 路由 → public/ 静态看板 → /v1 JSON 404 → 错误兜底。
//
// env（README 有表）：
//   PORT                监听端口，默认 5900（设计文档 §7.1）
//   OPS_DB_PATH         SQLite 路径，默认 ./data/ops.db（目录自动创建）
//   OPS_RETENTION_DAYS  events 原始表保留天数，默认 90
// 时区不做 env：day 归日依赖部署机 TZ（systemd 单元钉 TZ=Asia/Shanghai）。

const path = require('path');
const express = require('express');

const { openDb } = require('./lib/db');
const { createIngestRouter } = require('./lib/ingest');
const { createStatsRouter } = require('./lib/stats');

function createApp(opts) {
  const dbPath = (opts && opts.dbPath) || process.env.OPS_DB_PATH || path.join(__dirname, 'data', 'ops.db');
  const nowFn = (opts && opts.nowFn) || (() => new Date());
  const { db, dao, close } = openDb(dbPath);

  const app = express();
  app.use(express.json({ limit: '1mb' })); // ≤500 事件/批 × ~1KB ≈ 500KB，2 倍余量

  app.get('/healthz', (req, res) => res.json({ ok: true }));

  app.use('/v1', function authMiddleware(req, res, next) { next(); });
  app.use('/v1', createIngestRouter(dao, { nowFn }));
  app.use('/v1', createStatsRouter(dao, { nowFn }));

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
