import { api, el } from './api.js';
import { formatDate } from './format.js';
import { requireUser, showAlert, hideAlert } from './layout.js';

const me = await requireUser(['ADMIN']);
if (me) init();

const KIND = {
  REQUEST_SUBMITTED: 'New request', STEP_WAITING: 'Waiting for you', REQUEST_RESUBMITTED: 'Information received', REQUEST_APPROVED: 'Approved',
  APPROVED_UPLOAD: 'Upload needed', REQUEST_REJECTED: 'Rejected', NEEDS_INFO: 'Needs information', REQUEST_FULFILLED: 'Document ready',
  SLA_REMINDER: 'Deadline reminder', SLA_ESCALATION: 'Overdue', SECURITY_INVITE: 'Invitation', SECURITY_RESET: 'Password reset', SECURITY_VERIFY: 'Verification',
};

function init() {
  document.getElementById('content').classList.remove('hidden');
  const alertBox = document.getElementById('page-alert');
  const rows = document.getElementById('rows');
  const state = document.getElementById('list-state');
  const more = document.getElementById('more');
  const filter = document.getElementById('status-filter');
  let page = 1;

  filter.append(el('option', { value: '', text: 'All' }));
  for (const [v, t] of [['FAILED', 'Failed'], ['PENDING', 'Waiting to send'], ['SENT', 'Sent'], ['CANCELLED', 'Skipped']]) filter.append(el('option', { value: v, text: t }));
  filter.addEventListener('change', () => load());

  function row(n) {
    const retry = el('button', { class: 'btn btn--ghost btn--sm', type: 'button', text: 'Try again' });
    retry.addEventListener('click', async () => {
      hideAlert(alertBox);
      retry.disabled = true;
      try {
        await api(`/admin/notifications/${n._id}/retry`, { method: 'POST' });
        showAlert(alertBox, 'Queued for another attempt.', 'success');
        await load();
      } catch (err) {
        showAlert(alertBox, err.message);
        retry.disabled = false;
      }
    });
    return el(
      'tr',
      {},
      el('td', { text: formatDate(n.createdAt) }),
      el('td', { text: n.recipient ? `${n.recipient.name} (${n.recipient.role})` : 'Invitee' }),
      el('td', { text: KIND[n.type] || n.type }),
      el('td', {}, el('span', { class: `badge badge--${n.status === 'SENT' ? 'active' : n.status === 'FAILED' ? 'rejected' : 'inactive'}`, text: n.status })),
      el('td', { text: String(n.attempts) }),
      el('td', { text: n.lastError || '-' }),
      el('td', {}, n.status === 'FAILED' ? retry : '')
    );
  }

  async function load({ append = false } = {}) {
    if (append) page += 1;
    else {
      page = 1;
      rows.replaceChildren();
    }
    try {
      const qs = new URLSearchParams({ limit: '50', page: String(page) });
      if (filter.value) qs.set('status', filter.value);
      const { items, total } = await api(`/admin/notifications?${qs}`);
      state.className = items.length || append ? 'hidden' : 'state';
      if (!items.length && !append) state.textContent = 'No messages.';
      for (const n of items) rows.append(row(n));
      more.classList.toggle('hidden', rows.children.length >= total);
    } catch (err) {
      showAlert(alertBox, err.message);
    }
  }
  more.addEventListener('click', () => load({ append: true }));
  load();
}
