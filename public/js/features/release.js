// @ts-check
// release.js —— 版本发布页（应用自动更新的运维面，设计 TechDemos docs/APP-AUTO-UPDATE-DESIGN.md §7.3）。
// 一页搞定：当前已发布（+下架/回滚）｜草稿区上传两变体（XHR 报进度）｜填说明/版本地板 → 发布。
// 「发布」按钮的真正把关在服务端自检（两变体齐备 + 版本高于当前 + sha 复算一致），前端只做提示。
//
// 交互上的五条硬约束（都是踩出来的，别退回去）：
// · 上传必须有独立的「上传」按钮。只挂 file input 的 change 会在早退后无路可走——input.value 没变，
//   重选同一个文件不再触发 change，用户彻底卡死（体感就是「没有上传按钮」）。
// · 版本号非法的提示写在出问题的那一行，不写表单底部——底部离文件行太远，看不见，
//   而行内状态还停在「未上传」，会被误读成上传失败。
// · 「发布」按钮初始即 disabled。drafts 没回来 / 加载失败时若可点，服务端会回「草稿区缺 X 变体」，
//   让人以为包传丢了。
// · 首次上传成功后锁死版本号：两个变体必须落进同一个 staging/<ver>/，中途改版本会两边各缺一半。
// · 行内状态与「发布」闸门只看版本输入框里的那一个版本，而服务端草稿区是按版本分桶的多份状态。
//   只要两者分叉，已经传成功的包就在行内凭空消失、显示成「未上传」，「发布」跟着无解释地灰掉
//   （「未上传」的真实含义是"当前填的这个版本号下没有这个包"，字面却读作"你根本没传上去"）。
//   所以：① 版本号落定（change）必须补跑被搁置的上传，不能只清提示；② 包在别的版本里必须点破，
//   不能显示成「未上传」；③ 上传成功必须用回执就地渲染，不能把成功态押在随后那次 GET 上；
//   ④「发布」禁用时必须说得出差什么。

import { escapeHtml, fmtLocalFromIso } from '../core/fmt.js';

// 两个 exe 必需；Linux 独立版包可选（有就一起发，给中心机执行器体检提示升级用，见 lib/update.js 头注释）
// 产品维度（TechDemos docs/EVOLVE-SERVICE-SPLIT-DESIGN.md §5.6）：#release = 蚕丛客户端；#release/evolve = 自进化服务
// cancong-evolve 的 Linux 预构建包（独立版本号 / 发布区，不进蚕丛 manifest）。切换产品整页重载，页面状态天然清零。
const PRODUCTS = {
  cancong: { label: '蚕丛客户端', required: ['slim', 'with-linux'], optional: ['linux-x64', 'linux-arm64'] },
  evolve: { label: '自进化服务（Linux 包）', required: ['linux-x64'], optional: ['linux-arm64'] },
};
let PRODUCT = 'cancong';
let REQUIRED = PRODUCTS.cancong.required;
let VARIANTS = [...REQUIRED, ...PRODUCTS.cancong.optional];
const ACCEPT = { slim: '.exe', 'with-linux': '.exe', 'linux-x64': '.gz,.tar.gz', 'linux-arm64': '.gz,.tar.gz' };
/** @param {string} p */
const withProduct = (p) => (PRODUCT === 'cancong' ? p : p + (p.includes('?') ? '&' : '?') + 'product=' + PRODUCT);
const optional = (va) => !REQUIRED.includes(va);
const VER_RE = /^\d+\.\d+\.\d+$/;
const VER_HINT = '⚠ 请先填合法版本号（三段数字，如 0.0.4）';

/** @type {HTMLElement} */ let root;
/** @type {any} */ let data = null;               // /update/drafts 最近一次响应
/** @type {Record<string, string>} */ const uploading = {}; // variant → 进度文案（上传期间盖过草稿态）
/** @type {Record<string, File>} */ const picked = {};      // variant → 已选待传文件（点「上传」用得着）
/** @type {Record<string, string>} */ const rowErr = {};    // variant → 行内错误（红字，盖过草稿态）
let verLocked = false;                            // 已开传 → 锁版本号，防两变体落进不同 staging
let refreshSeq = 0;                               // refresh 代际：只认最后一次发起的响应（见 refresh）
let prefilled = '';                               // 被 refresh 静默预填进版本框的版本号（要在闸门里点破来源）

async function call(method, path, body) {
  /** @type {RequestInit} */
  const opts = { method, headers: {} };
  if (body !== undefined) {
    opts.headers = { 'Content-Type': 'application/json' };
    opts.body = JSON.stringify(body);
  }
  const res = await fetch('/v1' + withProduct(path), opts);
  if (res.status === 401) { location.href = '/login.html'; throw new Error('unauthorized'); }
  const j = await res.json().catch(() => null);
  if (!res.ok || !j || j.ok !== true) throw new Error((j && j.error) || ('HTTP ' + res.status));
  return j.data;
}

// 从文件名里抽三段版本号（构建产物天然叫 cancong-portable-<版本>[-with-linux].exe）。抽不到 → null。
// 归一后比较（0.0.04 与 0.0.4 视为同版本），与服务端 cmp3 的数值口径保持一致，免得前端报错、服务端放行。
const verFromName = (name) => {
  const m = /(?:^|[^\d.])(\d+\.\d+\.\d+)(?!\.?\d)/.exec(String(name || ''));
  return m ? m[1] : null;
};
const sameVer = (a, b) => a.split('.').map(Number).join('.') === b.split('.').map(Number).join('.');

const fmtMB = (n) => (Number(n || 0) / 1024 / 1024).toFixed(1) + ' MB';
const verInput = () => /** @type {HTMLInputElement} */ (root.querySelector('#rel-version'));
const versionValue = () => verInput().value.trim();
// #rel-msg 放操作结果（发布中/发布被拒/已删草稿），#rel-gate 只放「发布」为什么不能点。
// 分成两个元素是为了免掉消息优先级——一次刷新就把闸门文案重算，绝不会盖掉刚写的操作结果。
const setMsg = (t) => { root.querySelector('#rel-msg').textContent = t; };
const setGate = (t) => { root.querySelector('#rel-gate').textContent = t; };
const uploadBtn = (va) => root.querySelector(`.rel-upload[data-variant="${va}"]`);

// 这个变体是不是传到「别的版本」去了。换版本 / 静默预填都会让输入框版本与实际上传版本分叉，
// 不查这一下就只能显示「未上传」，而包明明好好躺在 staging/<别的版本>/ 里。
const elsewhereWith = (va, ver) => {
  const d = ((data && data.drafts) || []).find((x) => x.version !== ver && x.variants[va]);
  return d ? d.version : null;
};

function variantRow(va) {
  return `
    <div class="rel-variant" data-variant="${va}">
      <span class="rel-vname">${va}${optional(va) ? ' <span class="muted">可选</span>' : ''}</span>
      <input type="file" id="rel-file-${va}" accept="${ACCEPT[va]}">
      <button class="rel-upload" data-variant="${va}">上传</button>
      <span class="rel-status" id="rel-status-${va}"></span>
    </div>`;
}

/** @param {HTMLElement} el @param {string} [sub] 产品子路由（evolve） */
export function init(el, sub) {
  root = el;
  PRODUCT = sub === 'evolve' ? 'evolve' : 'cancong';
  REQUIRED = PRODUCTS[PRODUCT].required;
  VARIANTS = [...REQUIRED, ...PRODUCTS[PRODUCT].optional];
  el.innerHTML = `
    <div class="metric-seg rel-products">${Object.entries(PRODUCTS).map(([k, v]) =>
      `<a class="${k === PRODUCT ? 'on' : ''}" href="#release${k === 'cancong' ? '' : '/' + k}">${v.label}</a>`).join('')}</div>
    <div class="panel">
      <h3>当前已发布</h3>
      <div id="rel-current"></div>
    </div>
    <div class="panel">
      <h3>草稿区 · 发布新版本</h3>
      <div class="rel-form">
        <div class="rel-verline">
          <label>版本 <input id="rel-version" placeholder="如 0.0.4" size="10"></label>
          <button id="rel-unlock" hidden>换版本</button>
          <span class="muted">先填版本号，再选包上传——各变体必须同属一个版本</span>
        </div>
        ${VARIANTS.map(variantRow).join('')}
        <label>更新说明<br><textarea id="rel-notes" rows="4" cols="60" placeholder="用户可见（客户端「查看说明」）。提醒：预置工作流不随版本更新到存量用户，如有新增请在此说明"></textarea></label>
        <label>版本地板 <input id="rel-floor" placeholder="留空 = 不阻断" size="10"> <span class="muted">低于此版本的客户端将被阻断强制升级——唯一召回手段，慎用</span></label>
        <div><button id="rel-publish" disabled>发布</button> <span id="rel-msg" class="muted"></span></div>
        <div id="rel-gate" class="rel-gate"></div>
      </div>
    </div>
    <div class="panel">
      <h3>草稿区总览</h3>
      <div id="rel-drafts"></div>
    </div>
    <div class="error-box" id="rel-error"></div>`;

  for (const va of VARIANTS) {
    el.querySelector('#rel-file-' + va).addEventListener('change', (e) => onPick(va, e));
    el.querySelector(`.rel-upload[data-variant="${va}"]`).addEventListener('click', () => upload(va));
  }
  el.querySelector('#rel-publish').addEventListener('click', publish);
  el.querySelector('#rel-unlock').addEventListener('click', unlockVersion);
  el.querySelector('#rel-drafts').addEventListener('click', onDraftsClick);
  verInput().addEventListener('input', () => {
    prefilled = ''; // 用户自己动过了，不再是预填
    if (VER_RE.test(versionValue())) {
      verInput().classList.remove('rel-need');
      for (const va of VARIANTS) if (rowErr[va] === VER_HINT) delete rowErr[va]; // 版本补上了，撤掉那条提示
    }
    renderDraftStatus();
  });
  // 补跑挂在 change（失焦/回车）上，不能挂 input——理由见 resumePendingUploads 的注释
  verInput().addEventListener('change', resumePendingUploads);
  renderDraftStatus(); // drafts 还没回来也要先把「发布」按住（服务端拒绝的文案会被误读成包丢了）
}

// 切产品：整页重载（上传中 / 锁版本 / 代际守卫这些状态都按单产品写的，重载最干净）
/** @param {string} sub */
export function navigate(sub) {
  if ((sub === 'evolve' ? 'evolve' : 'cancong') !== PRODUCT) location.reload();
}

export async function refresh() {
  // 上传是分钟级长请求，期间 main.js 的 60s 轮询和 visibilitychange（等待时切走再切回）会并发发起刷新。
  // 谁后落地谁说了算的话，一个「上传完成前发出、完成后落地」的旧快照会把刚传好的变体抹掉，
  // 界面就成了「读条走完、传成功，却显示未上传」。只认最后一次发起的响应。
  const seq = ++refreshSeq;
  const errBox = root.querySelector('#rel-error');
  errBox.textContent = '';
  try {
    const fresh = await call('GET', '/update/drafts');
    if (seq !== refreshSeq) return; // 过期快照，丢弃
    data = fresh;
    renderCurrent();
    renderDrafts();
    // 版本输入为空时预填：优先草稿区最新版本。⚠ 预填是静默的，用户会当成自己填的，
    // 于是包传进了上一版的 staging/<ver>/ 还不自知——所以要记下来，在闸门那行点破来源。
    const vin = verInput();
    if (!vin.value && data.drafts.length) { vin.value = data.drafts[0].version; prefilled = vin.value; }
    renderDraftStatus();
  } catch (e) {
    if (seq !== refreshSeq) return; // 过期的失败不该去置灰按钮：更新的那次刷新还在路上
    errBox.textContent = '加载失败：' + /** @type {Error} */ (e).message;
    // 草稿区状态未知 → 绝不能让「发布」可点，否则服务端回「草稿区缺 X 变体」会被当成上传丢了
    /** @type {HTMLButtonElement} */ (root.querySelector('#rel-publish')).disabled = true;
    setGate('草稿区状态未知（加载失败），发布已锁定');
    throw e;
  }
}

function renderCurrent() {
  const box = root.querySelector('#rel-current');
  const p = data.published;
  if (!p) { box.innerHTML = '<div class="empty">尚无已发布版本（客户端查版返回 204，不提示更新）</div>'; return; }
  box.innerHTML = `
    <div class="rel-cur">
      <span class="rel-cur-ver">${escapeHtml(p.version)}</span>
      <span class="muted">发布于 ${fmtLocalFromIso(p.pubDate)}</span>
      ${p.minSupported ? `<span class="pill">地板 ${escapeHtml(p.minSupported)}</span>` : ''}
      <button id="rel-unpublish">下架/回滚</button>
    </div>`;
  box.querySelector('#rel-unpublish').addEventListener('click', unpublish);
}

// 草稿区总览：服务器上「真实有什么」——上面的表单只看输入框精确匹配的那一个版本，
// 传错版本号时那里恒显「未上传」，不给这张表用户根本不知道包去哪了。
function renderDrafts() {
  const box = root.querySelector('#rel-drafts');
  const list = (data && data.drafts) || [];
  if (!list.length) { box.innerHTML = '<div class="empty">草稿区为空（上传后出现在这里）</div>'; return; }
  box.innerHTML = list.map((d) => {
    const ver = escapeHtml(d.version);
    const cells = VARIANTS.map((va) => {
      const sc = d.variants[va];
      if (!sc) return optional(va) ? '' : `<span class="rel-draft-va rel-draft-miss">${va} 缺</span>`;
      return `<span class="rel-draft-va">${va}
        <span class="muted">${fmtMB(sc.size)} · sha ${escapeHtml(String(sc.sha256).slice(0, 8))}…</span>
        <button class="rel-del" data-ver="${ver}" data-va="${va}">删除</button></span>`;
    }).join('');
    return `<div class="rel-draft"><span class="rel-draft-ver">${ver}</span>${cells}
      <button class="rel-use" data-ver="${ver}">填入版本</button></div>`;
  }).join('');
}

function renderDraftStatus() {
  const ver = versionValue();
  const draft = (data && data.drafts.find((d) => d.version === ver)) || null;
  const missing = [];
  let ready = 0;
  for (const va of VARIANTS) {
    const el = root.querySelector('#rel-status-' + va);
    const sc = draft && draft.variants[va];
    if (sc) { if (!optional(va)) ready++; } // 就位与否只看服务端草稿区，本地选没选文件不算数
    else if (!optional(va)) missing.push(va);   // Linux 包可选：缺了不挡发布
    // 「已选待传」是待办不是空态：以前它和 ✓ 完成态、「未上传」空态共用一个 --muted 灰，
    // 三种语义看着一模一样，补填版本号后忘了点「上传」根本看不出来。rel-todo 把它拎成信号色。
    el.classList.remove('rel-err', 'rel-todo');
    uploadBtn(va).classList.remove('rel-todo');
    if (uploading[va]) { el.textContent = uploading[va]; continue; }
    if (rowErr[va]) {
      // 带上已选文件名：文件是留住了的，别让人以为要重选（重选同一个文件不触发 change，正是老坑）
      el.textContent = rowErr[va] + (picked[va] ? `（已选 ${picked[va].name}，留着直接点「上传」）` : '');
      el.classList.add('rel-err');
      if (picked[va]) uploadBtn(va).classList.add('rel-todo');
      continue;
    }
    if (sc) {
      el.textContent = `✓ ${fmtMB(sc.size)} · sha ${String(sc.sha256).slice(0, 8)}…`
        + (picked[va] ? '（已选新文件，点「上传」覆盖）' : '');
      if (picked[va]) { el.classList.add('rel-todo'); uploadBtn(va).classList.add('rel-todo'); }
    } else if (picked[va]) {
      el.textContent = `已选 ${picked[va].name} · ${fmtMB(picked[va].size)} —— 点「上传」`;
      el.classList.add('rel-todo');
      uploadBtn(va).classList.add('rel-todo');
    } else {
      // 「传到别的版本去了」≠「没传」。行内只认输入框那个版本，不点破的话包就凭空消失，
      // 用户只能读成上传丢了（真实事故：换版本后，刚读条传成功的包立刻显示「未上传」）。
      const other = elsewhereWith(va, ver);
      el.textContent = other
        ? `⚠ 版本 ${ver} 下没有此包——它在草稿 ${other} 里（点那行「填入版本」切过去，或重新上传）`
        : (optional(va) ? '未上传（可选）' : '未上传');
      if (other) el.classList.add('rel-todo');
    }
  }
  // 两包齐备才可点（客户端提示；真正把关在服务端自检）。有变体在传时也按住——
  // 发布会 rmSync 掉整个 staging/<ver>/，在途上传的 rename 会扑空。
  const busy = VARIANTS.some((va) => uploading[va]);
  /** @type {HTMLButtonElement} */ (root.querySelector('#rel-publish')).disabled = ready < REQUIRED.length || busy;
  verInput().readOnly = verLocked;
  /** @type {HTMLElement} */ (root.querySelector('#rel-unlock')).hidden = !verLocked;
  setGate(gateReason(missing, busy, ver));
}

// 「发布」灰着时必须说得出差什么。禁用本身是对的（服务端也会拒），但按钮只有 opacity: .45、
// 旁边一片空白，用户无从判断是"包没传上去"还是"页面坏了"——两条真实事故都卡在这一步。
function gateReason(missing, busy, ver) {
  const note = (prefilled && prefilled === ver && !verLocked)
    ? `（版本号 ${ver} 是从草稿区自动填入的，不是要发的版本请直接改）` : '';
  if (!data) return '草稿区加载中…';
  if (!VER_RE.test(ver)) return '先填合法版本号（三段数字，如 0.0.4），再选包上传';
  if (busy) return `⏳ ${VARIANTS.filter((va) => uploading[va]).join('、')} 正在上传，传完才能发布`;
  if (!missing.length) return note;
  const why = (va) => {
    if (picked[va]) return `${va}（文件已选好，点该行「上传」）`;
    const other = elsewhereWith(va, ver);
    if (other) return `${va}（它在草稿 ${other} 里，当前填的是 ${ver}）`;
    return `${va}（请选包上传）`;
  };
  return `必需变体（${REQUIRED.join('、')}）齐备才能发布，还差：${missing.map(why).join('；')}` + note;
}

// 版本号「落定」时，把之前因缺版本号被搁置的包补传上去。缺了这一步，先选包的变体永远停在
// 「已选待传」，而后选包的变体因版本号已就位自动传了——两边行为不对称，用户以为两个都传了，
// 「发布」却一直灰着（真实事故）。
// ⚠ 必须挂 change（失焦/回车）不能挂 input：逐字输入 0.4.10 会在打到 0.4.1 时抢跑上传，
// 而 upload() 里的 verLocked = true 会把版本号锁死在那个错版本上，再想改只能点「换版本」。
function resumePendingUploads() {
  if (!VER_RE.test(versionValue())) return;
  for (const va of VARIANTS) {
    // 带 rowErr 的（文件名版本对不上）刻意不补传——那条提示的全部意义就是逼人工看一眼再点「上传」
    if (picked[va] && !uploading[va] && !rowErr[va]) upload(va);
  }
}

// 把上传回执就地并进 data，让成功态立刻可见。不这么做的话，整个成功态就押在紧随其后的那次
// GET /update/drafts 上——它慢、失败、或被并发的旧快照盖掉，界面就是「传成功却显示未上传」。
function mergeDraft(ver, va, sc) {
  if (!data) return;
  let d = data.drafts.find((x) => x.version === ver);
  if (!d) { d = { version: ver, variants: {} }; data.drafts.unshift(d); } // 排序交给随后的 refresh 对齐
  d.variants[va] = sc;
}

function onPick(variant, e) {
  const f = /** @type {HTMLInputElement} */ (e.target).files[0];
  if (!f) { delete picked[variant]; renderDraftStatus(); return; }
  picked[variant] = f;
  delete rowErr[variant];
  // 版本号已就位就顺手开传（保留「选完即传」的便利）；没就位则只暂存，等用户点「上传」
  const ver = versionValue();
  if (!VER_RE.test(ver)) { needVersion(variant); return; }
  // 版本号是手输的自由文本，与包内容无关。发错包（标 0.0.4 实为 0.0.3）后果很重：所有客户端被告知
  // 「有新版本」，升完还是老版本 → 无限提示。文件名对不上就先按住不自动传，逼运维看一眼；
  // 确认无误再点「上传」即可放行（真正的把关在服务端发布自检，那里也拦同一件事）。
  const nv = verFromName(f.name);
  if (nv && !sameVer(nv, ver)) {
    rowErr[variant] = `⚠ 文件名版本 ${nv} 与填写的 ${ver} 不符——确认没发错包再点「上传」`;
    renderDraftStatus();
    return;
  }
  upload(variant);
}

// 版本号缺失/非法：提示落在出问题的那一行，同时把输入框高亮并聚焦——别让人去表单底部找小灰字
function needVersion(variant) {
  rowErr[variant] = VER_HINT;
  renderDraftStatus();
  verInput().classList.add('rel-need');
  verInput().focus();
}

function upload(variant) {
  const file = picked[variant];
  if (!file) { rowErr[variant] = '⚠ 请先选择文件'; renderDraftStatus(); return; }
  if (uploading[variant]) return;
  const ver = versionValue();
  if (!VER_RE.test(ver)) return needVersion(variant);

  delete rowErr[variant];
  setMsg('');
  const xhr = new XMLHttpRequest();
  const url = withProduct(`/v1/update/upload?variant=${encodeURIComponent(variant)}&version=${encodeURIComponent(ver)}&filename=${encodeURIComponent(file.name)}`);
  xhr.open('POST', url);
  xhr.upload.onprogress = (e) => {
    uploading[variant] = e.lengthComputable ? `⏳ 上传中 ${Math.floor(e.loaded / e.total * 100)}%` : '⏳ 上传中…';
    renderDraftStatus();
  };
  xhr.onload = () => {
    delete uploading[variant];
    if (xhr.status === 200) {
      delete picked[variant];
      /** @type {HTMLInputElement} */ (root.querySelector('#rel-file-' + variant)).value = '';
      // 先用回执把成功态渲染出来，再异步 refresh 对齐——别把「传成功了」押在下一个网络往返上
      try {
        const d = JSON.parse(xhr.responseText).data;
        mergeDraft(d.version, d.variant, { size: d.size, sha256: d.sha256 });
        renderDrafts();
      } catch (_) { /* 回执解析不了就等 refresh 兜底 */ }
      renderDraftStatus();
      refresh().catch(() => { /* 错误已进 #rel-error */ });
    } else {
      let err = 'HTTP ' + xhr.status;
      try { err = JSON.parse(xhr.responseText).error || err; } catch (_) { /* 保底 */ }
      // 文件仍留在 picked 里 → 直接点「上传」就能重试，不用再走一遍文件选择框
      rowErr[variant] = `✗ 上传失败：${err}（点「上传」重试）`;
      renderDraftStatus();
    }
  };
  xhr.onerror = () => {
    delete uploading[variant];
    rowErr[variant] = '✗ 上传失败：网络错误（点「上传」重试）';
    renderDraftStatus();
  };
  uploading[variant] = '⏳ 上传中 0%';
  verLocked = true; // 已经往 staging/<ver>/ 写东西了，此后改版本号只会让两个变体分家
  renderDraftStatus();
  xhr.send(file); // File 直接作 body，浏览器流式发送（octet-stream，不经服务端 json parser）
}

function unlockVersion() {
  for (const va of VARIANTS) {
    if (uploading[va]) { setMsg('有变体正在上传，等它结束再换版本'); return; }
  }
  verLocked = false;
  prefilled = '';
  for (const va of VARIANTS) {
    delete picked[va];
    delete rowErr[va];
    /** @type {HTMLInputElement} */ (root.querySelector('#rel-file-' + va)).value = '';
  }
  renderDraftStatus();
  // 这里清的只是本地已选文件。已经传到服务端的包一个都没动，换完版本它们会从行内状态里"消失"
  // （行内只认输入框那个版本），不说这一句就会被读成"我的包被删了"。
  setMsg('已解锁版本号。已传到服务端的包不受影响，仍在下面的「草稿区总览」里');
  verInput().focus();
}

async function onDraftsClick(e) {
  const t = e.target;
  if (!(t instanceof HTMLElement)) return;
  const ver = t.dataset.ver;
  if (!ver) return;
  if (t.classList.contains('rel-use')) {
    if (verLocked) { setMsg(`版本号已锁定在 ${versionValue()}，先点「换版本」`); return; }
    verInput().value = ver;
    verInput().classList.remove('rel-need');
    prefilled = '';
    for (const va of VARIANTS) if (rowErr[va] === VER_HINT) delete rowErr[va];
    resumePendingUploads(); // 这也是「版本号落定」，同样要补跑被搁置的上传
    renderDraftStatus();
    return;
  }
  if (t.classList.contains('rel-del') && t.dataset.va) {
    const va = t.dataset.va;
    if (!confirm(`确定删除草稿 ${ver} 的 ${va} 变体？删除后需重新上传。`)) return;
    try {
      await call('DELETE', `/update/draft/${encodeURIComponent(ver)}/${encodeURIComponent(va)}`);
      setMsg(`已删除草稿 ${ver} · ${va}`);
      await refresh();
    } catch (err) {
      setMsg(`删除失败：${/** @type {Error} */ (err).message}`);
    }
  }
}

async function publish() {
  const version = versionValue();
  const notes = /** @type {HTMLTextAreaElement} */ (root.querySelector('#rel-notes')).value;
  const minSupported = /** @type {HTMLInputElement} */ (root.querySelector('#rel-floor')).value.trim();
  setMsg('发布中（服务端复算 sha256）…');
  try {
    await call('POST', '/update/publish', { version, notes, minSupported });
    setMsg(`✓ ${version} 已发布`);
    verLocked = false; // 这一版收工，放开输入框准备下一版
    prefilled = '';
    await refresh();
  } catch (e) {
    setMsg('发布被拒：' + /** @type {Error} */ (e).message);
  }
}

async function unpublish() {
  if (!confirm(`确定下架当前版本 ${data.published.version}？将回退到上一个已发布版本（没有则清空）。`)) return;
  try {
    const r = await call('POST', '/update/unpublish');
    setMsg(r.published ? `已回退到 ${r.published.version}` : '已清空（客户端不再提示更新）');
    await refresh();
  } catch (e) {
    setMsg('下架失败：' + /** @type {Error} */ (e).message);
  }
}
