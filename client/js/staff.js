import { api, el } from './api.js';
import { STATUS_LABELS, statusBadge, formatDate } from './format.js';
import { requireUser, showAlert, hideAlert } from './layout.js';

// Shared dashboard for CLERK and HOD. Buttons are a convenience only:
// the backend re-checks role, department and current status on every action.
const ROLE = document.body.dataset.role;
const DEFAULT_FILTER = { CLERK: 'PENDING', HOD: 'UNDER_REVIEW' };
const HINTS = {
  CLERK: 'Review new requests, then the HOD decides. Approved requests wait here for the document upload.',
  HOD: 'Approve or reject requests that the Clerk has reviewed.',
};

const user = await requireUser([ROLE]);
if (user) init();

function init() {
  document.getElementById('content').classList.remove('hidden');
  document.getElementById('welcome').textContent = `${ROLE === 'CLERK' ? 'Clerk' : 'HOD'} dashboard · ${user.department}`;
  document.getElementById('hint').textContent = HINTS[ROLE];

  const filter = document.getElementById('status-filter');
  const list = document.getElementById('request-list');
  const state = document.getElementById('list-state');
  const alertBox = document.getElementById('page-alert');

  filter.append(el('option', { value: '', text: 'All statuses' }));
  for (const [value, label] of Object.entries(STATUS_LABELS)) filter.append(el('option', { value, text: label }));
  filter.value = DEFAULT_FILTER[ROLE];
  filter.addEventListener('change', () => load());

  let page = 1;
  const more = el('button', { class: 'btn btn--ghost hidden', type: 'button', text: 'Load more' });
  list.after(more);
  more.addEventListener('click', () => load({ append: true }));

  async function load({ append = false } = {}) {
    if (append) {
      page += 1;
      more.disabled = true;
    } else {
      page = 1;
      list.replaceChildren();
      more.classList.add('hidden');
      state.className = 'state';
      state.replaceChildren(el('div', { class: 'spinner' }), el('span', { text: 'Loading requests...' }));
    }
    try {
      const qs = new URLSearchParams({ limit: '20', page: String(page) });
      if (filter.value) qs.set('status', filter.value);
      const { items, total } = await api(`/requests?${qs}`);
      if (!append && !items.length) {
        state.replaceChildren(el('span', { text: 'No requests match this filter.' }));
        return;
      }
      state.className = 'hidden';
      for (const r of items) list.append(card(r));
      more.classList.toggle('hidden', list.children.length >= total);
      more.disabled = false;
    } catch (err) {
      if (append) {
        page -= 1;
        more.disabled = false;
      } else {
        state.className = 'alert alert--error';
        state.textContent = err.message;
      }
      if (append) showAlert(alertBox, err.message);
    }
  }

  async function run(button, path, body, method = 'PATCH') {
    hideAlert(alertBox);
    button.disabled = true;
    try {
      await api(path, { method, body });
      showAlert(alertBox, 'Done.', 'success');
    } catch (err) {
      const detail = err.errors?.map((x) => x.message).join(' ');
      // 409 means someone else already moved it; refresh so the list is truthful.
      showAlert(alertBox, detail || err.message);
    }
    await load();
  }

  function card(r) {
    const node = el(
      'article',
      { class: 'card req-card' },
      el('div', { class: 'req-head' }, el('h3', { text: r.documentType }), statusBadge(r.status)),
      el('p', { class: 'muted', text: `${r.studentId ? r.studentId.name : 'Unknown student'} · ${formatDate(r.createdAt)}` }),
      el('p', { text: r.purpose })
    );
    if (r.status === 'REJECTED' && r.rejectionReason) {
      node.append(el('p', { class: 'alert alert--error', text: `Reason: ${r.rejectionReason}` }));
    }

    const actions = el('div', { class: 'actions' });
    actions.append(
      el('a', { class: 'btn btn--ghost btn--sm', href: `/request.html?id=${encodeURIComponent(r._id)}`, text: 'Details' })
    );

    if (ROLE === 'CLERK' && r.status === 'PENDING') {
      const b = el('button', { class: 'btn btn--sm', type: 'button', text: 'Start review' });
      b.addEventListener('click', () => run(b, `/requests/${r._id}/review`));
      actions.append(b);
    }
    if (ROLE === 'HOD' && r.status === 'UNDER_REVIEW') {
      const approve = el('button', { class: 'btn btn--sm', type: 'button', text: 'Approve' });
      approve.addEventListener('click', () => run(approve, `/requests/${r._id}/approve`));
      const reject = el('button', { class: 'btn btn--danger btn--sm', type: 'button', text: 'Reject' });
      reject.addEventListener('click', () => node.append(rejectForm(r, reject)));
      actions.append(approve, reject);
    }
    if (r.status === 'FULFILLED') {
      actions.append(
        el('a', { class: 'btn btn--ghost btn--sm', href: `/api/requests/${encodeURIComponent(r._id)}/document`, download: '', text: 'Download document' })
      );
    }
    node.append(actions);
    if (ROLE === 'CLERK' && r.status === 'APPROVED') node.append(uploadForm(r));
    return node;
  }

  // The server re-validates type, real file signature, size and status.
  // The accept/size checks here only save a round trip.
  function uploadForm(r) {
    const input = el('input', { class: 'input', type: 'file', accept: '.pdf,.png,.jpg,.jpeg,application/pdf,image/png,image/jpeg', required: '', 'aria-label': 'Official document (PDF, JPG or PNG, max 5 MB)' });
    const err = el('div', { class: 'field-error', role: 'alert' });
    const send = el('button', { class: 'btn btn--sm', type: 'submit', text: 'Upload and fulfil' });
    const form = el(
      'form',
      { class: 'stack reject-form' },
      el('p', { class: 'hint', text: 'Approved. Upload the official document (PDF, JPG or PNG, max 5 MB).' }),
      input,
      err,
      send
    );
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      err.textContent = '';
      const file = input.files[0];
      if (!file) {
        err.textContent = 'Choose a file first.';
        return;
      }
      if (file.size > 5 * 1024 * 1024) {
        err.textContent = 'File is larger than 5 MB.';
        return;
      }
      const data = new FormData();
      data.append('document', file);
      run(send, `/requests/${r._id}/document`, data, 'POST');
    });
    return form;
  }

  function rejectForm(r, trigger) {
    trigger.disabled = true;
    const area = el('textarea', { class: 'input', maxlength: '500', required: '', 'aria-label': 'Rejection reason', placeholder: 'Reason for rejection (required)' });
    const err = el('div', { class: 'field-error', role: 'alert' });
    const confirm = el('button', { class: 'btn btn--danger btn--sm', type: 'submit', text: 'Confirm rejection' });
    const cancel = el('button', { class: 'btn btn--ghost btn--sm', type: 'button', text: 'Cancel' });
    const form = el('form', { class: 'stack reject-form' }, area, err, el('div', { class: 'actions' }, confirm, cancel));
    cancel.addEventListener('click', () => {
      form.remove();
      trigger.disabled = false;
    });
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      if (area.value.trim().length < 5) {
        err.textContent = 'Please give a reason (at least 5 characters).';
        return;
      }
      run(confirm, `/requests/${r._id}/reject`, { reason: area.value });
    });
    return form;
  }

  load();
}
