import { api, el, apiUrl } from './api.js';
import { formatDate } from './format.js';
import { requireUser } from './layout.js';

const ACTIONS = ["USER_REGISTERED","USER_LOGIN","USER_CREATED_BY_ADMIN","USER_ACTIVATED","USER_DEACTIVATED","REQUEST_SUBMITTED","REQUEST_REVIEWED","REQUEST_APPROVED","REQUEST_REJECTED","REQUEST_INFO_REQUESTED","REQUEST_RESUBMITTED","DOCUMENT_UPLOADED","REQUEST_FULFILLED","DOCUMENT_DOWNLOADED","TENANT_CREATED","PLATFORM_LOGIN","DEPARTMENT_CREATED","DEPARTMENT_UPDATED","DOCUMENT_TYPE_CREATED","DOCUMENT_TYPE_UPDATED","WORKFLOW_UPDATED","INVITE_CREATED","INVITE_RESENT","INVITE_REVOKED","INVITE_ACCEPTED","PASSWORD_CHANGED","PASSWORD_RESET","PASSWORD_RESET_ISSUED","EMAIL_VERIFIED","ACCOUNT_LOCKED","ACCOUNT_UNLOCKED","SESSIONS_REVOKED","MFA_ENABLED","MFA_DISABLED","DOCUMENT_ADDED","DOCUMENT_REPLACED","DOCUMENT_REVOKED","DOCUMENT_REJECTED_INFECTED","NOTIFICATION_RETRIED","DATA_EXPORTED","API_KEY_CREATED","API_KEY_REVOKED","WEBHOOK_CREATED","WEBHOOK_UPDATED","WEBHOOK_DELETED","BRANDING_UPDATED"];

const me = await requireUser(['ADMIN']);
if (me) init();

function init() {
  document.getElementById('content').classList.remove('hidden');
  const filter = document.getElementById('action-filter');
  const rows = document.getElementById('log-rows');
  const state = document.getElementById('table-state');
  const prev = document.getElementById('prev');
  const next = document.getElementById('next');
  const pageLabel = document.getElementById('page-label');
  const LIMIT = 25;
  let page = 1;
  let total = 0;

  filter.append(el('option', { value: '', text: 'All events' }));
  for (const a of ACTIONS) filter.append(el('option', { value: a, text: a.replaceAll('_', ' ').toLowerCase() }));
  const q = document.getElementById('q');
  const from = document.getElementById('from');
  const to = document.getElementById('to');
  const oldest = document.getElementById('oldest');
  const exportLink = document.getElementById('export');
  const verifyBtn = document.getElementById('verify');
  const verifyBox = document.getElementById('verify-result');
  const refilter = () => {
    page = 1;
    load();
  };
  let timer;
  q.addEventListener('input', () => {
    clearTimeout(timer);
    timer = setTimeout(refilter, 300);
  });
  for (const control of [filter, from, to, oldest]) control.addEventListener('change', refilter);
  const params = () => {
    const p = new URLSearchParams();
    if (filter.value) p.set('action', filter.value);
    if (q.value.trim()) p.set('q', q.value.trim());
    if (from.value) p.set('from', from.value);
    if (to.value) p.set('to', to.value);
    if (oldest.checked) {
      p.set('sort', 'seq');
      p.set('order', 'asc');
    }
    return p;
  };
  // Walks the whole chain on the server and recomputes every hash.
  verifyBtn.addEventListener('click', async () => {
    verifyBtn.disabled = true;
    verifyBox.className = 'state';
    verifyBox.textContent = 'Checking every entry...';
    try {
      const v = await api('/admin/audit-logs/verify');
      verifyBox.className = v.ok ? 'alert alert--success' : 'alert alert--error';
      verifyBox.textContent = v.ok
        ? `The audit chain is intact: ${v.checked} entries checked${v.unchained ? `, ${v.unchained} older entries are not part of the chain` : ''}. Head hash: ${v.headHash || 'none yet'}. Keep a copy of this hash somewhere else to notice a full rewrite.`
        : `The audit chain is BROKEN at entry ${v.broken.seq}: ${v.broken.reason}.`;
    } catch (err) {
      verifyBox.className = 'alert alert--error';
      verifyBox.textContent = err.message;
    } finally {
      verifyBtn.disabled = false;
    }
  });
  prev.addEventListener('click', () => {
    page -= 1;
    load();
  });
  next.addEventListener('click', () => {
    page += 1;
    load();
  });

  async function load() {
    rows.replaceChildren();
    state.className = 'state';
    state.replaceChildren(el('div', { class: 'spinner' }), el('span', { text: 'Loading audit log...' }));
    try {
      const qs = params();
      qs.set('page', String(page));
      qs.set('limit', String(LIMIT));
      exportLink.href = apiUrl(`/admin/audit-logs/export.csv?${params()}`);
      const data = await api(`/admin/audit-logs?${qs}`);
      total = data.total;
      if (!data.items.length) {
        state.replaceChildren(el('span', { text: 'No audit events yet.' }));
      } else {
        state.className = 'hidden';
        for (const l of data.items) rows.append(row(l));
      }
    } catch (err) {
      state.className = 'alert alert--error';
      state.textContent = err.message;
    }
    const pages = Math.max(1, Math.ceil(total / LIMIT));
    pageLabel.textContent = `Page ${page} of ${pages} · ${total} events`;
    prev.disabled = page <= 1;
    next.disabled = page >= pages;
  }

  function row(l) {
    const detail = l.details && Object.keys(l.details).length ? JSON.stringify(l.details) : '';
    return el(
      'tr',
      {},
      el('td', { text: formatDate(l.timestamp) }),
      el('td', {}, el('span', { class: 'badge', text: l.action.replaceAll('_', ' ') })),
      el('td', { text: l.actorId ? `${l.actorId.name} (${l.actorId.role})` : '-' }),
      el('td', { class: 'mono', text: l.seq ? String(l.seq) : '-' }),
      el('td', { class: 'mono', text: l.requestId ? String(l.requestId).slice(-8) : '-' }),
      el('td', { class: 'muted', text: detail })
    );
  }

  load();
}
