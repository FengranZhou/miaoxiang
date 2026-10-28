// 妙想 · 身份登记页（两个字段：姓名 + 部门）
// 上报规范出自 chrome-pack-feishu：保存成功后直接 fetch 上报 event=register
// 视觉令牌与工具面板同源（toolbar/ui-tokens.js）

try { window.__liaisonUITokens && window.__liaisonUITokens.ensure() } catch (_) {}

const WEBHOOK_URL = 'https://yf2ljykclb.xfchat.iflytek.com/base/automation/webhook/event/Hj5SaSl8ZwzU8WhAuFuruP9szSg';
const ASSET_NAME = 'miaoxiang';
const DEPT_PREFIX = '体验中心';
const DEPTS = ['1部', '2部', '3部', '4部', '5部', '6部', '7部'];

const $ = (id) => document.getElementById(id);
let selectedDept = null; // '体验中心N部' 或 '__other__'

function uuidv4() {
  if (crypto && crypto.randomUUID) return crypto.randomUUID();
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
    const r = (Math.random() * 16) | 0;
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  });
}

async function sessionId() {
  try {
    const got = await chrome.storage.session.get(['feishu_session_id']);
    if (got.feishu_session_id) return got.feishu_session_id;
    const id = uuidv4();
    await chrome.storage.session.set({ feishu_session_id: id });
    return id;
  } catch (_) { return uuidv4(); }
}

// register 事件（13 字段，对齐 feishu-tracker v2）
async function reportRegister(identity) {
  try {
    const payload = JSON.stringify({
      user_id: identity.user_id,
      name: identity.name,
      dept: identity.dept,
      source: 'chrome',
      asset: ASSET_NAME,
      type: 'chrome-plugin',
      trigger: 'inline',
      session: await sessionId(),
      user: '',
      host: (navigator.userAgent.match(/\(([^)]+)\)/) || [])[1] || 'chrome',
      extra: '',
      event: 'register',
      version: chrome.runtime.getManifest().version
    });
    await fetch(WEBHOOK_URL, { method: 'POST', mode: 'no-cors', headers: { 'Content-Type': 'application/json' }, body: payload });
  } catch (_) {}
}

// ── 部门胶囊 ──
function renderChips() {
  const wrap = $('capsules');
  wrap.innerHTML = '';
  const add = (text, value) => {
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'chip'; b.textContent = text;
    b.dataset.value = value;
    b.setAttribute('role', 'radio');
    b.setAttribute('aria-checked', 'false');
    b.addEventListener('click', () => selectDept(value));
    wrap.appendChild(b);
  };
  DEPTS.forEach(d => add(d, DEPT_PREFIX + d));
  add('其他', '__other__');
}

function selectDept(value) {
  selectedDept = value;
  document.querySelectorAll('.chip').forEach(b => {
    const on = b.dataset.value === value;
    b.classList.toggle('on', on);
    b.setAttribute('aria-checked', String(on));
  });
  $('deptCustom').hidden = value !== '__other__';
  if (value === '__other__') $('deptCustom').focus();
  $('formError').textContent = '';
}

// ── 视图切换 ──
function showDone(identity) {
  $('formView').hidden = true;
  $('badgeView').hidden = false;
  $('badgeName').textContent = identity.name;
  $('badgeDept').textContent = identity.dept;
  $('title').textContent = '已登记';
  $('lede').textContent = '关闭本页即可开始使用';
}

function showForm(identity) {
  $('badgeView').hidden = true;
  $('formView').hidden = false;
  $('title').textContent = '登记一下';
  $('lede').textContent = '用于统计小组使用情况，只需一次';
  if (!identity) return;
  $('name').value = identity.name || '';
  const known = DEPTS.map(d => DEPT_PREFIX + d);
  if (known.includes(identity.dept)) selectDept(identity.dept);
  else if (identity.dept) { selectDept('__other__'); $('deptCustom').value = identity.dept; }
}

// ── 初始化 ──
renderChips();
chrome.storage.local.get(['identity'], (r) => {
  if (r.identity && r.identity.user_id) showDone(r.identity);
  else $('name').focus();
});

// ── 保存 ──
function fail(msg, focusEl) {
  $('formError').textContent = msg;
  if (focusEl) focusEl.focus();
}

$('save').addEventListener('click', () => {
  const name = $('name').value.trim();
  if (!name) return fail('请填写姓名', $('name'));
  let dept;
  if (selectedDept === '__other__') {
    dept = $('deptCustom').value.trim();
    if (!dept) return fail('请填写部门名', $('deptCustom'));
  } else if (selectedDept) {
    dept = selectedDept;
  } else {
    return fail('请选择部门');
  }
  chrome.storage.local.get(['identity'], (r) => {
    const old = r.identity;
    const identity = {
      user_id: old && old.user_id ? old.user_id : uuidv4(), // 修改信息时沿用原 ID，表里仍算同一人
      name, dept,
      created_at: old && old.created_at ? old.created_at : new Date().toISOString()
    };
    chrome.storage.local.set({ identity }, async () => {
      showDone(identity);
      $('lede').textContent = '登记完成，页面即将关闭';
      // 先等上报发完再关：页面一关，进行中的 fetch 会被中断，register 就丢了。
      // 最多等 3 秒，网络慢也不让用户干等。
      await Promise.race([reportRegister(identity), new Promise(r => setTimeout(r, 3000))]);
      setTimeout(closeSelf, 800);   // 留一眼确认时间
    });
  });
});

// 关闭本页：openOptionsPage 打开的是普通标签页，window.close() 会被浏览器拦，
// 改用 tabs.remove（不需要 tabs 权限）。在扩展管理页的内嵌弹窗里打开时
// 拿不到 tab，退回 window.close()。
function closeSelf() {
  try {
    chrome.tabs.getCurrent((tab) => {
      if (tab && tab.id != null) chrome.tabs.remove(tab.id);
      else window.close();
    });
  } catch (_) { window.close(); }
}

// 回车直接提交
$('name').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('save').click(); });
$('deptCustom').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('save').click(); });

$('edit').addEventListener('click', () => {
  chrome.storage.local.get(['identity'], (r) => showForm(r.identity));
});
