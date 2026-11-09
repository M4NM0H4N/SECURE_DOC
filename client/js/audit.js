import { api, el } from './api.js';
import { formatDate } from './format.js';
import { requireUser } from './layout.js';

const ACTIONS = [
  'USER_REGISTERED', 'USER_LOGIN', 'USER_CREATED_BY_ADMIN', 'USER_ACTIVATED', 'USER_DEACTIVATED',
  'REQUEST_SUBMITTED', 'REQUEST_REVIEWED', 'REQUEST_APPROVED', 'REQUEST_REJECTED',
  'DOCUMENT_UPLOADED', 'REQUEST_FULFILLED', 'DOCUMENT_DOWNLOADED',
];

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
  filter.addEventListener('change', () => {
    page = 1;
    load();
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
      const qs = new URLSearchParams({ page: String(page), limit: String(LIMIT) });
      if (filter.value) qs.set('action', filter.value);
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
      el('td', { class: 'mono', text: l.requestId ? String(l.requestId).slice(-8) : '-' }),
      el('td', { class: 'muted', text: detail })
    );
  }

  load();
}
