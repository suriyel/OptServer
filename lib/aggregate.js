'use strict';
// aggregate.js —— 夜间 job：核对补算 + 滚动清理 + 空间回收 + 进程内调度。
//
// 补算是安全网而非主路径：ingest 的 events 插入与 daily bump 在同一事务里，理论无漂移；
// 补算窗口只取最近 3 天（覆盖 spool 迟到与任何意外漂移）。两条边界：
// · heartbeats 列永不补算（心跳不落 events，物理不可重算——见 db.js 铁律 2）；
// · 只修「窗口内有 events」的行；纯心跳日的 daily 行 SELECT 产不出组，天然不动。

const { localDay, shiftDay } = require('./time-utils');

const RECOMPUTE_WINDOW_DAYS = 3;
const HB_SEEN_RETENTION_DAYS = 7;
const DELETE_CHUNK = 10000;

// 距下一个「本地 hour 点整」的毫秒数（本地时间语义，随部署机 TZ 走）
function msUntilNextRun(now, hour) {
  const h = hour == null ? 3 : hour;
  const next = new Date(now.getFullYear(), now.getMonth(), now.getDate(), h, 0, 0, 0);
  if (next <= now) next.setDate(next.getDate() + 1);
  return next - now;
}

// 跑一轮完整 job；幂等（补算 upsert、清理按边界），早跑/多跑无害。自己 catch 不外抛。
function runNightlyJob(dao, opts) {
  const nowFn = (opts && opts.nowFn) || (() => new Date());
  const retentionDays = (opts && opts.retentionDays) || 90;
  const now = nowFn();
  const today = localDay(now);
  try {
    const recomputedFrom = shiftDay(today, -RECOMPUTE_WINDOW_DAYS);
    dao.recomputeDaily(recomputedFrom);
    dao.recomputeDailyTool(recomputedFrom);
    dao.recomputeDailyFail(recomputedFrom);

    // day < cutoff 删除、day == cutoff 保留；分块删避免长事务锁写路径
    const cutoff = shiftDay(today, -retentionDays);
    let deletedEvents = 0;
    for (;;) {
      const n = dao.deleteEventsBefore(cutoff, DELETE_CHUNK);
      deletedEvents += n;
      if (n === 0) break;
    }
    const deletedHb = dao.deleteHbSeenBefore(shiftDay(today, -HB_SEEN_RETENTION_DAYS));

    dao.incrementalVacuum();       // 回收删除释放的页（凌晨无竞争，全量回收）
    dao.walCheckpointTruncate();   // 大删后收 WAL 体积
    dao.optimize();                // 刷新计划器统计（partial 覆盖索引选取依赖它，随数据增长保鲜）

    const result = { ok: true, recomputedFrom, deletedEvents, deletedHb };
    dao.metaSet('last_job_day', today);
    dao.metaSet('last_job_at', now.toISOString());
    dao.metaSet('last_job_result', JSON.stringify(result));
    console.log('[aggregate] nightly ok: recomputedFrom=' + recomputedFrom
      + ' deletedEvents=' + deletedEvents + ' deletedHb=' + deletedHb);
    return result;
  } catch (e) {
    // 失败不记 last_job_day：下次启动的补跑与明晚定时都会重试
    console.log('[aggregate] nightly failed:', e.message);
    try { dao.metaSet('last_job_result', JSON.stringify({ ok: false, error: e.message })); } catch (_) {}
    return { ok: false, error: e.message };
  }
}

// 进程内调度：setTimeout 链（休眠/挂钟漂移后重算下一个 3 点，不像 setInterval 累积偏差）。
// 启动补跑：上次成功日 != 今日 → 延迟一小段后补跑一次（覆盖错过 3 点的重启、宕机数日）。
function startScheduler(dao, opts) {
  opts = opts || {};
  const nowFn = opts.nowFn || (() => new Date());
  const hour = opts.hour == null ? 3 : opts.hour;
  const catchupDelayMs = opts.catchupDelayMs == null ? 30000 : opts.catchupDelayMs;
  let timer = null;
  let catchupTimer = null;
  let running = false;
  let stopped = false;

  function fire() {
    if (stopped || running) return; // 防重入（job 同步执行，双保险）
    running = true;
    try { runNightlyJob(dao, opts); } finally { running = false; }
  }

  function schedule() {
    if (stopped) return;
    timer = setTimeout(() => { fire(); schedule(); }, msUntilNextRun(nowFn(), hour));
    if (timer.unref) timer.unref(); // 定时器不吊住进程退出
  }

  if (dao.metaGet('last_job_day') !== localDay(nowFn())) {
    catchupTimer = setTimeout(fire, catchupDelayMs);
    if (catchupTimer.unref) catchupTimer.unref();
  }
  schedule();

  return {
    stop() { stopped = true; clearTimeout(timer); clearTimeout(catchupTimer); },
    fire, // 手动触发口（测试/运维）
  };
}

module.exports = { runNightlyJob, startScheduler, msUntilNextRun };
