'use strict';
// center/scheduler.js —— 自进化队列的每日窗口（设计 §5.3：默认 02:00，错开 03:00 夜间重算）。
// 与 aggregate.startScheduler 并排的另一条 setTimeout 链；区别：job 是异步的（回环调蚕丛 + 轮询），
// 防重入交给 runner 的单飞标志。窗口时刻**每次排期时现读配置**（配置页改了，下一轮就生效，不用重启）。
// 只在真实进程挂载（server.js require.main 分支），测试 require createApp 不带它。

const { msUntilNextRun } = require('../aggregate');
const { readConfig } = require('../evolve-config');

function startEvolveScheduler(dao, runner, opts) {
  const nowFn = (opts && opts.nowFn) || (() => new Date());
  let timer = null;
  let stopped = false;

  function schedule() {
    if (stopped) return;
    timer = setTimeout(async () => {
      try { await runner.processQueue({ trigger: 'window' }); }
      catch (e) { console.log('[evolve-center] window run error:', e && e.message); }
      schedule();
    }, msUntilNextRun(nowFn(), readConfig(dao).windowHour));
    if (timer.unref) timer.unref();
  }
  schedule();
  return { stop() { stopped = true; clearTimeout(timer); } };
}

module.exports = { startEvolveScheduler };
