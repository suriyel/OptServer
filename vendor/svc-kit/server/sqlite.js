'use strict';
// kit/server/sqlite.js —— SQLite 打开 + 版本化迁移骨架（user_version 单调前进）。
// PRAGMA 时序敏感：auto_vacuum 只对未建表的空库生效，必须先于 DDL。
// ⚠ 迁移只进不退：库升到 vN 后回退代码不会重跑旧迁移 ⇒ 升级前备份库，回退 = 还原备份 + 回退代码。

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

function runMigrations(db, migrations, log) {
  const say = log || ((m) => console.log(m));
  for (const m of migrations) {
    if (db.pragma('user_version', { simple: true }) >= m.version) continue;
    db.transaction(() => {
      db.exec(m.sql);
      db.pragma('user_version = ' + m.version);
    })();
    say('[db] migrated to v' + m.version);
  }
}

function openSqlite(dbPath, migrations, log) {
  if (dbPath !== ':memory:') fs.mkdirSync(path.dirname(path.resolve(dbPath)), { recursive: true });
  const db = new Database(dbPath);
  if (db.pragma('user_version', { simple: true }) === 0) db.pragma('auto_vacuum = INCREMENTAL');
  db.pragma('journal_mode = WAL');      // 持久于库文件，重复设置无害
  db.pragma('synchronous = NORMAL');    // 连接级，每次打开都要设
  db.pragma('busy_timeout = 5000');     // 备份工具旁挂时兜底
  runMigrations(db, migrations || [], log);
  return db;
}

module.exports = { openSqlite, runMigrations };
