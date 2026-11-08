'use strict';
// kit/server/skeleton.js —— 服务骨架：json body + /healthz（门禁之前）、/v1 JSON 404 + 错误兜底、优雅退出。

const express = require('express');

// 门禁之前装：探活永不受鉴权影响
function applyBase(app, opts) {
  app.use(express.json({ limit: (opts && opts.jsonLimit) || '1mb' })); // ≤500 事件/批 × ~1KB ≈ 500KB，2 倍余量
  app.get('/healthz', (req, res) => res.json({ ok: true }));
}

// 路由与静态资源之后装：/v1 未命中 → JSON 404；含 express.json 解析错误（400/413 带 err.status），其余一律 500
function applyTail(app, opts) {
  const api = (opts && opts.apiPrefix) || '/v1';
  const tag = (opts && opts.logTag) || '[server]';
  app.use(api, (req, res) => res.status(404).json({ ok: false, error: 'not found' }));
  app.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
    const status = err.status || err.statusCode || 500;
    console.log(tag + ' error', status, String(err.message));
    res.status(status).json({ ok: false, error: status >= 500 ? 'server error' : 'bad request' });
  });
}

// 优雅退出：先停调度器 → srv.close 等既有连接收尾后关库退出 → 兜底强退（systemd Restart 场景不吊死）
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

module.exports = { applyBase, applyTail, gracefulShutdown };
