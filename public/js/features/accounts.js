// @ts-check
// accounts.js —— 管理员账号管理弹层 + 本人修改密码弹层。
// 非 tab 页（不进 main.js 的 PAGES）；由顶栏用户菜单按需打开。

import { escapeHtml } from '../core/fmt.js';
import { listUsers, createUser, deleteUser, changePassword } from '../core/auth.js';

// 通用弹层：插入 body，点遮罩/关闭按钮/Esc 关闭。返回 { root, close }。
function openModal(title, bodyHtml) {
  const overlay = document.createElement('div');
  overlay.className = 'modal';
  overlay.innerHTML = `
    <div class="modal-card" role="dialog" aria-modal="true">
      <div class="modal-head">
        <h3>${escapeHtml(title)}</h3>
        <button class="modal-close" type="button" aria-label="关闭">✕</button>
      </div>
      <div class="modal-body">${bodyHtml}</div>
    </div>`;
  document.body.appendChild(overlay);
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  function close() { overlay.remove(); document.removeEventListener('keydown', onKey); }
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
  overlay.querySelector('.modal-close').addEventListener('click', close);
  document.addEventListener('keydown', onKey);
  return { root: overlay, close };
}

// 账号管理（管理员）：用户列表 + 新增用户表单
export function openAccounts() {
  const { root } = openModal('账号管理', `
    <div class="error-box" id="acc-error"></div>
    <div id="acc-list" class="acc-list"><div class="empty">加载中…</div></div>
    <form id="acc-add" class="acc-form" autocomplete="off">
      <input id="acc-username" class="filter-input" placeholder="新用户名（字母数字 . _ -）" autocomplete="off">
      <input id="acc-password" class="filter-input" type="password" placeholder="初始密码（≥6 位）" autocomplete="new-password">
      <button type="submit" class="export-btn">新增用户</button>
    </form>`);
  const err = /** @type {HTMLElement} */ (root.querySelector('#acc-error'));
  const listEl = /** @type {HTMLElement} */ (root.querySelector('#acc-list'));

  async function render() {
    err.textContent = '';
    try {
      const d = await listUsers();
      if (!d.users.length) { listEl.innerHTML = '<div class="empty">暂无账号</div>'; return; }
      const rows = d.users.map((u) => `<tr>
        <td>${escapeHtml(u.username)}</td>
        <td>${u.role === 'admin' ? '<span class="pill pill-admin">管理员</span>' : '<span class="pill">用户</span>'}</td>
        <td class="muted">${escapeHtml(String(u.createdAt || '').slice(0, 10))}</td>
        <td class="num">${u.role === 'admin' ? '' : `<button type="button" class="link-danger" data-del="${escapeHtml(u.username)}">删除</button>`}</td>
      </tr>`).join('');
      listEl.innerHTML = `<table><thead><tr>
        <th>用户名</th><th>角色</th><th>创建</th><th class="num"></th>
      </tr></thead><tbody>${rows}</tbody></table>`;
    } catch (e) {
      listEl.innerHTML = '';
      err.textContent = '加载失败：' + /** @type {Error} */ (e).message;
    }
  }

  listEl.addEventListener('click', async (e) => {
    const b = /** @type {HTMLElement} */ (e.target).closest('[data-del]');
    if (!b) return;
    const uname = b.getAttribute('data-del');
    if (!confirm(`确认删除用户 "${uname}"？其登录会话会一并失效。`)) return;
    err.textContent = '';
    try { await deleteUser(uname); await render(); }
    catch (e2) { err.textContent = '删除失败：' + /** @type {Error} */ (e2).message; }
  });

  root.querySelector('#acc-add').addEventListener('submit', async (e) => {
    e.preventDefault();
    err.textContent = '';
    const uInput = /** @type {HTMLInputElement} */ (root.querySelector('#acc-username'));
    const pInput = /** @type {HTMLInputElement} */ (root.querySelector('#acc-password'));
    const username = uInput.value.trim();
    const password = pInput.value;
    if (!username || password.length < 6) { err.textContent = '用户名不能为空，密码至少 6 位'; return; }
    try {
      await createUser(username, password);
      uInput.value = ''; pInput.value = '';
      await render();
    } catch (e2) {
      const m = /** @type {Error} */ (e2).message;
      err.textContent = m === 'username exists' ? '用户名已存在'
        : m === 'invalid username' ? '用户名只能含字母数字与 . _ -（≤64 位）'
        : m === 'password too short' ? '密码至少 6 位'
        : '新增失败：' + m;
    }
  });

  render();
}

// 修改本人密码（所有登录用户可用）
export function openChangePassword() {
  const { root, close } = openModal('修改密码', `
    <div class="error-box" id="pw-msg"></div>
    <form id="pw-form" class="acc-form-col" autocomplete="off">
      <input id="pw-old" class="filter-input" type="password" placeholder="当前密码" autocomplete="current-password">
      <input id="pw-new" class="filter-input" type="password" placeholder="新密码（≥6 位）" autocomplete="new-password">
      <button type="submit" class="export-btn">确认修改</button>
    </form>`);
  const msg = /** @type {HTMLElement} */ (root.querySelector('#pw-msg'));
  root.querySelector('#pw-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    msg.style.color = '';
    msg.textContent = '';
    const oldPassword = /** @type {HTMLInputElement} */ (root.querySelector('#pw-old')).value;
    const newPassword = /** @type {HTMLInputElement} */ (root.querySelector('#pw-new')).value;
    if (newPassword.length < 6) { msg.textContent = '新密码至少 6 位'; return; }
    try {
      await changePassword(oldPassword, newPassword);
      msg.style.color = 'var(--green)';
      msg.textContent = '密码已修改';
      setTimeout(close, 900);
    } catch (e2) {
      const m = /** @type {Error} */ (e2).message;
      msg.textContent = m === 'invalid credentials' ? '当前密码错误'
        : m === 'password too short' ? '新密码至少 6 位'
        : '修改失败：' + m;
    }
  });
}
