import { api, el } from './api.js';
import { DOCUMENT_TYPES, statusBadge, formatDate } from './format.js';
import { requireUser, showAlert, hideAlert } from './layout.js';

const user = await requireUser(['STUDENT']);
if (user) init();

function init() {
  document.getElementById('content').classList.remove('hidden');
  document.getElementById('welcome').textContent = `Welcome, ${user.name}`;

  const form = document.getElementById('request-form');
  const alertBox = document.getElementById('form-alert');
  const submit = document.getElementById('submit');
  const type = document.getElementById('documentType');
  const purpose = document.getElementById('purpose');
  const counter = document.getElementById('purpose-count');
  const list = document.getElementById('request-list');
  const state = document.getElementById('list-state');

  type.append(el('option', { value: '', text: 'Select a document' }));
  for (const t of DOCUMENT_TYPES) type.append(el('option', { value: t, text: t }));

  purpose.addEventListener('input', () => {
    counter.textContent = `${purpose.value.length}/500`;
  });

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
      state.replaceChildren(el('div', { class: 'spinner' }), el('span', { text: 'Loading your requests...' }));
    }
    try {
      const qs = new URLSearchParams({ limit: '20', page: String(page) });
      const { items, total } = await api(`/requests?${qs}`);
      if (!append && !items.length) {
        state.replaceChildren(el('span', { text: 'You have not requested any documents yet.' }));
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

  function card(r) {
    const node = el(
      'article',
      { class: 'card req-card' },
      el('div', { class: 'req-head' }, el('h3', { text: r.documentType }), statusBadge(r.status)),
      el('p', { class: 'muted', text: r.purpose }),
      el('p', { class: 'hint', text: `Submitted ${formatDate(r.createdAt)}` })
    );
    if (r.status === 'REJECTED' && r.rejectionReason) {
      node.append(el('p', { class: 'alert alert--error', text: `Reason: ${r.rejectionReason}` }));
    }
    const actions = el(
      'div',
      { class: 'actions' },
      el('a', { class: 'btn btn--ghost btn--sm', href: `/request.html?id=${encodeURIComponent(r._id)}`, text: 'View details' })
    );
    if (r.status === 'FULFILLED') {
      actions.append(
        el('a', { class: 'btn btn--sm', href: `/api/requests/${encodeURIComponent(r._id)}/document`, download: '', text: 'Download document' })
      );
    }
    node.append(actions);
    return node;
  }

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    hideAlert(alertBox);
    submit.disabled = true;
    submit.textContent = 'Submitting...';
    try {
      await api('/requests', { method: 'POST', body: { documentType: type.value, purpose: purpose.value } });
      form.reset();
      counter.textContent = '0/500';
      showAlert(alertBox, 'Request submitted. Track its status below.', 'success');
      await load();
    } catch (err) {
      const detail = err.errors?.map((x) => x.message).join(' ');
      showAlert(alertBox, detail || err.message);
    } finally {
      submit.disabled = false;
      submit.textContent = 'Submit request';
    }
  });

  load();
}
