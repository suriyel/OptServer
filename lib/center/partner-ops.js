'use strict';
// center/partner-ops.js —— 本仓经回环调用的蚕丛接口清单（TechDemos docs/BLUEPRINT-SELF-EVOLUTION-DESIGN.md §11.1 D1）。
// 蚕丛那边把这些 op 标成 x-stability: partner（只许新增可选字段，锁在 TechDemos api-spec/partner.lock.json）。
// 两处用它：执行器体检逐个确认在线规格里都在且仍是 partner（lib/center/health.js）；契约测试确认本表 ≡ 规格 partner 集合
// ≡ cancong-client 实际调用集合（__tests__/cancong-contract.test.js）。新增一个调用 ⇒ 这里加一行，并请蚕丛那边标 partner + 重锁。

const PARTNER_OPS = Object.freeze([
  ['get', '/api/settings'],
  ['put', '/api/settings'],
  ['get', '/_marketplace/catalog'],
  ['post', '/_marketplace/publish'],
  ['get', '/_blueprint/{id}/file'],
  ['post', '/_blueprint/{id}/file'],
  ['delete', '/_blueprint/{id}'],
  ['post', '/_blueprint/import'],
  ['post', '/_blueprint/run'],
  ['get', '/_blueprint/state'],
  ['post', '/_blueprint/stop-session'],
  ['get', '/_api/openapi.json'],
  ['get', '/_env/list'],
]);

module.exports = { PARTNER_OPS };
