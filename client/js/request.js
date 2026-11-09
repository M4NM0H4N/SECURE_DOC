import { api, el, ROLE_HOME } from './api.js';
import { statusBadge, formatDate, STATUS_LABELS } from './format.js';
import { requireUser } from './layout.js';

const user = await requireUser(['STUDENT', 'CLERK', 'HOD', 'ADMIN']);
if (user) init();

async function init() {
  const root = document.getElementById('detail');
  document.getElementById('back').href = ROLE_HOME[user.role];

  const fail = (msg) => root.replaceChildren(el('div', { class: 'alert alert--error', text: msg }));

  const id = new URLSearchParams(location.search).get('id');
  if (!id) return fail('No request selected.');

  try {
    const { request: r } = await api(`/requests/${encodeURIComponent(id)}`);
    root.replaceChildren(
      el('div', { class: 'req-head' }, el('h1', { text: r.documentType }), statusBadge(r.status)),
      el(
        'dl',
        { class: 'meta' },
        ...row('Purpose', r.purpose),
        ...row('Student', r.studentId ? `${r.studentId.name} (${r.studentId.email})` : '-'),
        ...row('Department', r.department),
        ...row('Submitted', formatDate(r.createdAt)),
        ...row('Last updated', formatDate(r.updatedAt))
      ),
      r.status === 'REJECTED' && r.rejectionReason
        ? el('div', { class: 'alert alert--error', text: `Rejection reason: ${r.rejectionReason}` })
        : '',
      r.status === 'FULFILLED' && user.role !== 'ADMIN'
        ? el('div', { class: 'actions' }, el('a', { class: 'btn btn--sm', href: `/api/requests/${encodeURIComponent(r._id)}/document`, download: '', text: 'Download document' }))
        : '',
      el('h2', { text: 'History' }),
      timeline(r.statusHistory)
    );
  } catch (err) {
    fail(err.status === 404 ? 'Request not found.' : err.message);
  }
}

function row(label, value) {
  return [el('dt', { text: label }), el('dd', { text: value })];
}

function timeline(history) {
  const ol = el('ol', { class: 'timeline' });
  for (const h of history) {
    ol.append(
      el(
        'li',
        {},
        el('strong', { text: STATUS_LABELS[h.to] || h.to }),
        el('span', { class: 'muted', text: ` · ${formatDate(h.at)}${h.by ? ` · ${h.by.name}` : ''}` }),
        h.note ? el('div', { class: 'hint', text: h.note }) : ''
      )
    );
  }
  return ol;
}
