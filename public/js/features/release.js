// @ts-check
// release.js —— 版本发布页（应用自动更新的运维面，设计 TechDemos docs/APP-AUTO-UPDATE-DESIGN.md §7.3）。
// 一页搞定：当前已发布（+下架/回滚）｜草稿区上传两变体（XHR 报进度）｜填说明/版本地板 → 发布。
// 「发布」按钮的真正把关在服务端自检（两变体齐备 + 版本高于当前 + sha 复算一致），前端只做提示。

import { escapeHtml, fmtLocalFromIso } from '../core/fmt.js';

/** @type {HTMLElement} */ let root;
/** @type {any} */ let data = null;          // /update/drafts 最近一次响应
/** @type {Record<string, string>} */ const uploading = {}; // variant → 进度文案（上传期间盖过草稿态）

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
        <label>版本 <input id="rel-version" placeholder="如 0.0.4" size="10"></label>
        <div class="rel-variant" data-variant="slim">
          <span class="rel-vname">slim</span>
          <input type="file" id="rel-file-slim" accept=".exe">
          <span class="rel-status" id="rel-status-slim"></span>
        </div>
        <div class="rel-variant" data-variant="with-linux">
          <span class="rel-vname">with-linux</span>
          <input type="file" id="rel-file-with-linux" accept=".exe">
          <span class="rel-status" id="rel-status-with-linux"></span>
        </div>
        <label>更新说明<br><textarea id="rel-notes" rows="4" cols="60" placeholder="用户可见（客户端「查看说明」）。提醒：预置工作流不随版本更新到存量用户，如有新增请在此说明"></textarea></label>
        <label>版本地板 <input id="rel-floor" placeholder="留空 = 不阻断" size="10"> <span class="muted">低于此版本的客户端将被阻断强制升级——唯一召回手段，慎用</span></label>
        <div><button id="rel-publish">发布</button> <span id="rel-msg" class="muted"></span></div>
      </div>
    </div>
    <div class="error-box" id="rel-error"></div>`;

  for (const va of ['slim', 'with-linux']) {
    el.querySelector('#rel-file-' + va).addEventListener('change', (e) => {
      const f = /** @type {HTMLInputElement} */ (e.target).files[0];
      if (f) upload(va, f);
    });
  }
  el.querySelector('#rel-publish').addEventListener('click', publish);
  el.querySelector('#rel-version').addEventListener('input', renderDraftStatus);
}

export async function refresh() {
  const errBox = root.querySelector('#rel-error');
  errBox.textContent = '';
  try {
    data = await call('GET', '/update/drafts');
    renderCurrent();
    // 版本输入为空时预填：优先草稿区最新版本
    const vin = /** @type {HTMLInputElement} */ (root.querySelector('#rel-version'));
    if (!vin.value && data.drafts.length) vin.value = data.drafts[0].version;
    renderDraftStatus();
  } catch (e) {
    errBox.textContent = '加载失败：' + /** @type {Error} */ (e).message;
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

function renderDraftStatus() {
  const ver = /** @type {HTMLInputElement} */ (root.querySelector('#rel-version')).value.trim();
  const draft = (data && data.drafts.find((d) => d.version === ver)) || null;
  let ready = 0;
  for (const va of ['slim', 'with-linux']) {
    const el = root.querySelector('#rel-status-' + va);
    if (uploading[va]) { el.textContent = uploading[va]; continue; }
    const sc = draft && draft.variants[va];
    if (sc) {
      ready++;
      el.textContent = `✓ ${fmtMB(sc.size)} · sha ${sc.sha256.slice(0, 8)}…`;
    } else {
      el.textContent = '未上传';
    }
  }
  // 两包齐备才可点（客户端提示；真正把关在服务端自检）
  /** @type {HTMLButtonElement} */ (root.querySelector('#rel-publish')).disabled = ready < 2;
}

function upload(variant, file) {
  const ver = /** @type {HTMLInputElement} */ (root.querySelector('#rel-version')).value.trim();
  const msg = root.querySelector('#rel-msg');
  if (!/^\d+\.\d+\.\d+$/.test(ver)) { msg.textContent = '先填合法版本号（三段数字）再选文件'; return; }
  msg.textContent = '';
  const xhr = new XMLHttpRequest();
  const url = `/v1/update/upload?variant=${encodeURIComponent(variant)}&version=${encodeURIComponent(ver)}&filename=${encodeURIComponent(file.name)}`;
  xhr.open('POST', url);
  xhr.upload.onprogress = (e) => {
    uploading[variant] = e.lengthComputable ? `⏳ 上传中 ${Math.floor(e.loaded / e.total * 100)}%` : '⏳ 上传中…';
    renderDraftStatus();
  };
  xhr.onload = () => {
    delete uploading[variant];
    if (xhr.status === 200) { refresh(); } else {
      let err = 'HTTP ' + xhr.status;
      try { err = JSON.parse(xhr.responseText).error || err; } catch (_) { /* 保底 */ }
      msg.textContent = `${variant} 上传失败：${err}`;
      renderDraftStatus();
    }
  };
  xhr.onerror = () => {
    delete uploading[variant];
    msg.textContent = `${variant} 上传失败：网络错误`;
    renderDraftStatus();
  };
  uploading[variant] = '⏳ 上传中 0%';
  renderDraftStatus();
  xhr.send(file); // File 直接作 body，浏览器流式发送（octet-stream，不经服务端 json parser）
}

async function publish() {
  const msg = root.querySelector('#rel-msg');
  const version = /** @type {HTMLInputElement} */ (root.querySelector('#rel-version')).value.trim();
  const notes = /** @type {HTMLTextAreaElement} */ (root.querySelector('#rel-notes')).value;
  const minSupported = /** @type {HTMLInputElement} */ (root.querySelector('#rel-floor')).value.trim();
  msg.textContent = '发布中（服务端复算 sha256）…';
  try {
    await call('POST', '/update/publish', { version, notes, minSupported });
    msg.textContent = `✓ ${version} 已发布`;
    await refresh();
  } catch (e) {
    msg.textContent = '发布被拒：' + /** @type {Error} */ (e).message;
  }
}

async function unpublish() {
  if (!confirm(`确定下架当前版本 ${data.published.version}？将回退到上一个已发布版本（没有则清空）。`)) return;
  const msg = root.querySelector('#rel-msg');
  try {
    const r = await call('POST', '/update/unpublish');
    msg.textContent = r.published ? `已回退到 ${r.published.version}` : '已清空（客户端不再提示更新）';
    await refresh();
  } catch (e) {
    msg.textContent = '下架失败：' + /** @type {Error} */ (e).message;
  }
}
