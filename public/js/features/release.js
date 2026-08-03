// @ts-check
// release.js —— 版本发布页（应用自动更新的运维面，设计 TechDemos docs/APP-AUTO-UPDATE-DESIGN.md §7.3）。
// 一页搞定：当前已发布（+下架/回滚）｜草稿区上传两变体（XHR 报进度）｜填说明/版本地板 → 发布。
// 「发布」按钮的真正把关在服务端自检（两变体齐备 + 版本高于当前 + sha 复算一致），前端只做提示。
//
// 交互上的四条硬约束（都是踩出来的，别退回去）：
// · 上传必须有独立的「上传」按钮。只挂 file input 的 change 会在早退后无路可走——input.value 没变，
//   重选同一个文件不再触发 change，用户彻底卡死（体感就是「没有上传按钮」）。
// · 版本号非法的提示写在出问题的那一行，不写表单底部——底部离文件行太远，看不见，
//   而行内状态还停在「未上传」，会被误读成上传失败。
// · 「发布」按钮初始即 disabled。drafts 没回来 / 加载失败时若可点，服务端会回「草稿区缺 X 变体」，
//   让人以为包传丢了。
// · 首次上传成功后锁死版本号：两个变体必须落进同一个 staging/<ver>/，中途改版本会两边各缺一半。

import { escapeHtml, fmtLocalFromIso } from '../core/fmt.js';

const VARIANTS = ['slim', 'with-linux'];
const VER_RE = /^\d+\.\d+\.\d+$/;
const VER_HINT = '⚠ 请先填合法版本号（三段数字，如 0.0.4）';

/** @type {HTMLElement} */ let root;
/** @type {any} */ let data = null;               // /update/drafts 最近一次响应
/** @type {Record<string, string>} */ const uploading = {}; // variant → 进度文案（上传期间盖过草稿态）
/** @type {Record<string, File>} */ const picked = {};      // variant → 已选待传文件（点「上传」用得着）
/** @type {Record<string, string>} */ const rowErr = {};    // variant → 行内错误（红字，盖过草稿态）
let verLocked = false;                            // 已开传 → 锁版本号，防两变体落进不同 staging

async function call(method, path, body) {
  /** @type {RequestInit} */
  const opts = { method, headers: {} };
  if (body !== undefined) {
    opts.headers = { 'Content-Type': 'application/json' };
    opts.body = JSON.stringify(body);
  }
  const res = await fetch('/v1' + path, opts);
  if (res.status === 401) { location.href = '/login.html'; throw new Error('unauthorized'); }
  const j = await res.json().catch(() => null);
  if (!res.ok || !j || j.ok !== true) throw new Error((j && j.error) || ('HTTP ' + res.status));
  return j.data;
}

const fmtMB = (n) => (Number(n || 0) / 1024 / 1024).toFixed(1) + ' MB';
const verInput = () => /** @type {HTMLInputElement} */ (root.querySelector('#rel-version'));
const versionValue = () => verInput().value.trim();
const setMsg = (t) => { root.querySelector('#rel-msg').textContent = t; };

function variantRow(va) {
  return `
    <div class="rel-variant" data-variant="${va}">
      <span class="rel-vname">${va}</span>
      <input type="file" id="rel-file-${va}" accept=".exe">
      <button class="rel-upload" data-variant="${va}">上传</button>
      <span class="rel-status" id="rel-status-${va}"></span>
    </div>`;
}

export function init(el) {
  root = el;
  el.innerHTML = `
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
          <span class="muted">先填版本号，再选包上传——两个变体必须同属一个版本</span>
        </div>
        ${VARIANTS.map(variantRow).join('')}
        <label>更新说明<br><textarea id="rel-notes" rows="4" cols="60" placeholder="用户可见（客户端「查看说明」）。提醒：预置工作流不随版本更新到存量用户，如有新增请在此说明"></textarea></label>
        <label>版本地板 <input id="rel-floor" placeholder="留空 = 不阻断" size="10"> <span class="muted">低于此版本的客户端将被阻断强制升级——唯一召回手段，慎用</span></label>
        <div><button id="rel-publish" disabled>发布</button> <span id="rel-msg" class="muted"></span></div>
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
    if (VER_RE.test(versionValue())) {
      verInput().classList.remove('rel-need');
      for (const va of VARIANTS) if (rowErr[va] === VER_HINT) delete rowErr[va]; // 版本补上了，撤掉那条提示
    }
    renderDraftStatus();
  });
  renderDraftStatus(); // drafts 还没回来也要先把「发布」按住（服务端拒绝的文案会被误读成包丢了）
}

export async function refresh() {
  const errBox = root.querySelector('#rel-error');
  errBox.textContent = '';
  try {
    data = await call('GET', '/update/drafts');
    renderCurrent();
    renderDrafts();
    // 版本输入为空时预填：优先草稿区最新版本
    const vin = verInput();
    if (!vin.value && data.drafts.length) vin.value = data.drafts[0].version;
    renderDraftStatus();
  } catch (e) {
    errBox.textContent = '加载失败：' + /** @type {Error} */ (e).message;
    // 草稿区状态未知 → 绝不能让「发布」可点，否则服务端回「草稿区缺 X 变体」会被当成上传丢了
    /** @type {HTMLButtonElement} */ (root.querySelector('#rel-publish')).disabled = true;
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
      if (!sc) return `<span class="rel-draft-va rel-draft-miss">${va} 缺</span>`;
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
  let ready = 0;
  for (const va of VARIANTS) {
    const el = root.querySelector('#rel-status-' + va);
    const sc = draft && draft.variants[va];
    if (sc) ready++;                       // 就位与否只看服务端草稿区，本地选没选文件不算数
    el.classList.remove('rel-err');
    if (uploading[va]) { el.textContent = uploading[va]; continue; }
    if (rowErr[va]) {
      // 带上已选文件名：文件是留住了的，别让人以为要重选（重选同一个文件不触发 change，正是老坑）
      el.textContent = rowErr[va] + (picked[va] ? `（已选 ${picked[va].name}，留着直接点「上传」）` : '');
      el.classList.add('rel-err');
      continue;
    }
    if (sc) {
      el.textContent = `✓ ${fmtMB(sc.size)} · sha ${String(sc.sha256).slice(0, 8)}…`
        + (picked[va] ? '（已选新文件，点「上传」覆盖）' : '');
    } else if (picked[va]) {
      el.textContent = `已选 ${picked[va].name} · ${fmtMB(picked[va].size)} —— 点「上传」`;
    } else {
      el.textContent = '未上传';
    }
  }
  // 两包齐备才可点（客户端提示；真正把关在服务端自检）。有变体在传时也按住——
  // 发布会 rmSync 掉整个 staging/<ver>/，在途上传的 rename 会扑空。
  const busy = VARIANTS.some((va) => uploading[va]);
  /** @type {HTMLButtonElement} */ (root.querySelector('#rel-publish')).disabled = ready < 2 || busy;
  verInput().readOnly = verLocked;
  /** @type {HTMLElement} */ (root.querySelector('#rel-unlock')).hidden = !verLocked;
}

function onPick(variant, e) {
  const f = /** @type {HTMLInputElement} */ (e.target).files[0];
  if (!f) { delete picked[variant]; renderDraftStatus(); return; }
  picked[variant] = f;
  delete rowErr[variant];
  // 版本号已就位就顺手开传（保留「选完即传」的便利）；没就位则只暂存，等用户点「上传」
  if (VER_RE.test(versionValue())) upload(variant);
  else { needVersion(variant); }
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
  const url = `/v1/update/upload?variant=${encodeURIComponent(variant)}&version=${encodeURIComponent(ver)}&filename=${encodeURIComponent(file.name)}`;
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
  for (const va of VARIANTS) {
    delete picked[va];
    delete rowErr[va];
    /** @type {HTMLInputElement} */ (root.querySelector('#rel-file-' + va)).value = '';
  }
  renderDraftStatus();
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
    for (const va of VARIANTS) if (rowErr[va] === VER_HINT) delete rowErr[va];
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
