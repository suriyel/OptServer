'use strict';
// backfill.js —— 回填 recency（`daily_user.last_at` / `daily_blueprint.last_at`）。
// 用法：node scripts/backfill.js [--db /var/lib/cancong-ops/ops.db] [--dry]
//      缺省 --db 时取 OPS_DB_PATH，再缺省 ./data/ops.db（与 server.js 同口径）。
//
// 为什么单独成脚本、不塞进迁移：迁移在 openDb 里随进程启动跑、且整段在一个事务里；
// 回填要扫全量 events（生产可达 700 万行），塞进去会把启动阻塞到 systemd 的 TimeoutStartSec。
// DDL_V4 因此只有两条 ADD COLUMN（纯元数据、O(1)），重活留给本脚本手动跑一次。
//
// 与增量的关系：**互不依赖**。即使本脚本一直不跑，ingest 也从升级那一刻起正常写 last_at，
// 只是历史行留 NULL（看板显示「—」而非报错）。所以本步骤可中止、可延后、可重跑。
//
// 幂等：逐日 UPDATE 都是「从 events 重算后覆盖」，跑两遍结果相同；中断后直接重跑即可。
// 口径：与 ingest.js::eventAtOf 和夜间重算共用 lib/db.js 的 EVENT_AT_EXPR（client_ts +
// 单向未来阀 + UTC 归一），三条路径逐位一致，有 __tests__/recency.test.js 守着。
//
// 在线执行安全性：WAL 下单写者 + 多读者，本脚本按**天**分事务（一天约几千行写），
// 锁持有时间百毫秒级，与 ingest 争锁由 busy_timeout=5000 兜底；真被卡住也不丢数据
// ——客户端 fail-open + spool 会补发。停服跑最干净，但不是必须。

const fs = require('fs');
const path = require('path');

const { openDb } = require('../lib/db');

function arg(name, dflt) {
  const i = process.argv.indexOf('--' + name);
  return i > -1 && process.argv[i + 1] != null ? process.argv[i + 1] : dflt;
}
const hasFlag = (name) => process.argv.includes('--' + name);

function main() {
  const dbPath = path.resolve(String(arg('db', process.env.OPS_DB_PATH || './data/ops.db')));
  const dry = hasFlag('dry');

  // 与 migrate.js 同边界：openDb 会给不存在的路径造一个空库并迁到最新版，那在
  // 「回填已有生产库」的语境里只意味着 --db 打错了。宁可报错也不要静默造空库。
  if (!fs.existsSync(dbPath)) {
    console.error('[backfill] 库不存在：' + dbPath);
    console.error('[backfill] 本脚本只回填已有库；请检查 --db / OPS_DB_PATH。');
    process.exit(1);
  }

  console.log('[backfill] 库 ' + dbPath + (dry ? '（--dry：只统计，不写入）' : ''));
  const { dao, close } = openDb(dbPath); // 顺带保证 schema 已迁到 v4
  const t0 = Date.now();
  try {
    const before = dao.qCountNullLastAt();
    console.log('[backfill] 回填前 last_at 为空：daily_user ' + before.users
      + ' 行 / daily_blueprint ' + before.blueprints + ' 行');

    // events 里现存的全部归属日（保留窗内，默认 90 天）。这些日子能精确到秒地重算。
    const days = dao.qDaysWithEvents('');
    if (!days.length) {
      console.log('[backfill] events 表为空，无可精确回填的日子。');
    } else {
      console.log('[backfill] events 覆盖 ' + days.length + ' 天：' + days[0] + ' ~ ' + days[days.length - 1]);
    }

    if (dry) {
      console.log('[backfill] --dry 模式结束，未写入任何数据。');
      return;
    }

    let touchedUsers = 0, touchedBps = 0;
    days.forEach((day, i) => {
      const r = dao.backfillDay(day); // 一天一个事务
      touchedUsers += r.users;
      touchedBps += r.blueprints;
      // 长回填要看得见进度：每 10 天报一行，末尾必报
      if ((i + 1) % 10 === 0 || i === days.length - 1) {
        console.log('[backfill] 精确回填 ' + (i + 1) + '/' + days.length + ' 天（至 ' + day + '）');
      }
    });

    // events 已被 90 天清理的更早日子：只能用当日 day 兜底成**日精度**。
    // 用 12:00Z 占位而非 00:00Z——在 [-12,+12] 的任何部署时区下它都仍落在同一个本地日内，
    // 不会因时区换算被推到前后一天。仅填 NULL 行，绝不覆盖上面算出的精确值。
    const cutoff = days.length ? days[0] : null;
    let fb = { users: 0, blueprints: 0 };
    if (cutoff) {
      fb = dao.backfillFallbackBefore(cutoff);
      console.log('[backfill] 日精度兜底（' + cutoff + ' 之前，events 已清理）：daily_user '
        + fb.users + ' 行 / daily_blueprint ' + fb.blueprints + ' 行');
    } else {
      console.log('[backfill] 无 events，跳过日精度兜底（无从判断切分点）。');
    }

    // 时段分布（daily_hour）：整表按 events 窗口重建。与 recency 不同，它**没有日精度兜底**
    // ——小时信息只存在于 events.client_ts 里，events 一清就物理不可重建，更早的日子永远空白。
    if (cutoff) {
      const n = dao.backfillHoursFrom(cutoff);
      console.log('[backfill] 时段分布重建（' + cutoff + ' 起）：' + n + ' 行');
      console.log('[backfill]   注：' + cutoff + ' 之前的时段数据无法重建（events 已按保留期清理，'
        + '小时信息只存在于原始事件里）——看板会标注数据起始日。');
    }

    const after = dao.qCountNullLastAt();
    const ms = Date.now() - t0;
    console.log('[backfill] 完成（耗时 ' + ms + 'ms）');
    console.log('[backfill]   精确回填触碰行数：daily_user ' + touchedUsers + ' / daily_blueprint ' + touchedBps);
    console.log('[backfill]   回填后仍为空：daily_user ' + after.users + ' 行 / daily_blueprint ' + after.blueprints + ' 行');
    // 剩余的 NULL 不是失败：纯心跳日的 daily_user 行本就没有实质使用，last_at 该是 NULL
    // （语义 = 「装了但当天没用」）。把它说清楚，免得运维以为回填漏了。
    if (after.users > 0) {
      console.log('[backfill]   注：daily_user 的剩余空行多为「当天只有心跳、无实质使用」，'
        + 'last_at 为空是正确语义，不是漏填。');
    }
  } finally {
    close();
  }
}

try {
  main();
} catch (e) {
  console.error('[backfill] 失败：' + (e && e.message ? e.message : String(e)));
  console.error('[backfill] 逐日事务，失败的那天整体回滚；已完成的天保留，直接重跑即可（幂等）。');
  process.exit(1);
}
