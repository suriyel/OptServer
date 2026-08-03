'use strict';
// migrate.js —— 对已有生产库单独执行 schema 迁移，不启动服务。
// 用法：node scripts/migrate.js [--db /var/lib/cancong-ops/ops.db]
//      缺省 --db 时取 OPS_DB_PATH，再缺省 ./data/ops.db（与 server.js 同口径）。
//
// 设计：不复制任何 DDL——直接调 lib/db.js 的 openDb()，其内部就是 runMigrations，
// 是仓库里迁移的唯一真源。本脚本只负责「报告前后 user_version + 计时 + 守边界」，
// 因此不可能与 MIGRATIONS 数组漂移，将来加 v4 也不用改这里。
//
// 运行时机：停服后、启动新代码前。（运行中也能跑——WAL 允许并发——但建索引期间持写锁，
// ingest 写入会等待，超 busy_timeout=5000 的请求返 500 让客户端落 spool 补发。停服跑最干净。）
//
// 幂等：已是最新版本时 runMigrations 逐项跳过，脚本原样退出 0，重复执行安全。

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const { openDb } = require('../lib/db');

function arg(name, dflt) {
  const i = process.argv.indexOf('--' + name);
  return i > -1 && process.argv[i + 1] != null ? process.argv[i + 1] : dflt;
}

// 只读地窥一眼当前 schema 版本。独立连接、用完即关——绝不能借 openDb 来读，
// 那会顺手把迁移跑了，"迁移前版本"就永远等于迁移后版本。
function peekVersion(dbPath) {
  const db = new Database(dbPath, { readonly: true });
  try { return db.pragma('user_version', { simple: true }); } finally { db.close(); }
}

function main() {
  const dbPath = path.resolve(String(arg('db', process.env.OPS_DB_PATH || './data/ops.db')));

  // openDb 对不存在的路径会建一个全新空库并迁到最新版——那是 server 首次启动的正确行为，
  // 但在「迁移已有生产库」的语境里，它只意味着 --db 打错了。宁可报错也不要静默造空库。
  if (!fs.existsSync(dbPath)) {
    console.error('[migrate] 库不存在：' + dbPath);
    console.error('[migrate] 本脚本只迁移已有库，不负责创建；请检查 --db / OPS_DB_PATH。');
    process.exit(1);
  }

  const before = peekVersion(dbPath);
  console.log('[migrate] 库 ' + dbPath);
  console.log('[migrate] 迁移前 user_version = ' + before);

  const t0 = Date.now();
  // openDb 内部：PRAGMA → runMigrations（逐项打印 [db] migrated to vN）→ prepare 全部 DAO。
  // prepare 顺带校验了所有 SQL 能对新 schema 编译通过，等于免费做了一次装配自检。
  const { db, close } = openDb(dbPath);
  let after;
  try {
    after = db.pragma('user_version', { simple: true });
  } finally {
    close();
  }
  const ms = Date.now() - t0;

  if (after === before) {
    console.log('[migrate] 无待迁移项，已是 v' + after + '（耗时 ' + ms + 'ms）');
  } else {
    console.log('[migrate] 完成：v' + before + ' → v' + after + '（耗时 ' + ms + 'ms）');
  }
}

try {
  main();
} catch (e) {
  console.error('[migrate] 失败：' + (e && e.message ? e.message : String(e)));
  console.error('[migrate] 库未被改动（迁移在事务内，失败即整体回滚）。');
  process.exit(1);
}
