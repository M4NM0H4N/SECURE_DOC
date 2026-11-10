import { api, el, tpath, apiUrl } from './api.js';
import { statusBadge, formatDate } from './format.js';
import { requireUser, showAlert, hideAlert } from './layout.js';


// Search, sort and CSV export for a list of requests (S7). The server applies the same scope to all
// three, so these only ever narrow what the person may already see.
function addListTools(anchor, getBase, reload) {
  const search = el('input', { class: 'input', type: 'search', maxlength: '80', placeholder: 'Search purpose, type or student', 'aria-label': 'Search requests' });
  const sort = el('select', { class: 'select', 'aria-label': 'Sort requests' });
  for (const [v, t] of [['createdAt:desc', 'Newest first'], ['createdAt:asc', 'Oldest first'], ['documentType:asc', 'Document type'], ['status:asc', 'Status']]) sort.append(el('option', { value: v, text: t }));
  const csv = el('a', { class: 'btn btn--ghost btn--sm', href: '#', text: 'Download CSV' });
  let timer;
  search.addEventListener('input', () => {
    clearTimeout(timer);
    timer = setTimeout(reload, 300);
  });
  sort.addEventListener('change', reload);
  anchor.before(el('div', { class: 'form-row form-row--2' }, el('div', { class: 'field' }, search), el('div', { class: 'field' }, sort)), el('div', { class: 'actions' }, csv));
  return {
    params() {
      const p = getBase();
      if (search.value.trim()) p.set('q', search.value.trim());
      const [field, order] = sort.value.split(':');
      p.set('sort', field);
      p.set('order', order);
      csv.href = apiUrl(`/requests/export.csv?${p}`);
      return p;
    },
  };
}

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

  // When the institution requires it, an unverified student must confirm their e-mail before requesting.
  api('/auth/me').then((me) => {
    if (me.verificationRequired && !me.user.emailVerifiedAt) {
      const resend = el('button', { class: 'btn btn--ghost btn--sm', type: 'button', text: 'Send me a verification link' });
      resend.addEventListener('click', async () => {
        resend.disabled = true;
        try {
          await api('/auth/resend-verification', { method: 'POST' });
          showAlert(alertBox, 'If your address still needs verifying, a new link has been sent.', 'success');
        } catch (err) {
          showAlert(alertBox, err.message);
          resend.disabled = false;
        }
      });
      form.before(el('div', { class: 'alert alert--warning' }, el('p', { text: 'Please verify your e-mail address before submitting a request. Check your inbox for the link.' }), resend));
    }
  }).catch(() => {});

  type.append(el('option', { value: '', text: 'Select a document' }));
  api('/meta/options')
    .then(({ documentTypes }) => {
      for (const t of documentTypes) type.append(el('option', { value: t, text: t }));
    })
    .catch((err) => showAlert(alertBox, err.message));

  purpose.addEventListener('input', () => {
    counter.textContent = `${purpose.value.length}/500`;
  });

  let page = 1;
  const tools = addListTools(state, () => new URLSearchParams(), () => load());
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
      const qs = tools.params();
      qs.set('limit', '20');
      qs.set('page', String(page));
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
    if (r.currentStep && !['FULFILLED', 'REJECTED'].includes(r.status)) {
      node.append(el('p', { class: 'hint', text: `Waiting on: ${r.currentStep}` }));
    }
    if (r.status === 'NEEDS_INFO') {
      const ask = [...(r.statusHistory || [])].reverse().find((h) => h.to === 'NEEDS_INFO');
      node.append(el('p', { class: 'alert alert--warning', text: `The reviewer asks: ${ask && ask.note ? ask.note : 'please update your request.'}` }));
      node.append(resubmitForm(r));
    }
    const actions = el(
      'div',
      { class: 'actions' },
      el('a', { class: 'btn btn--ghost btn--sm', href: tpath(`/request.html?id=${encodeURIComponent(r._id)}`), text: 'View details' })
    );
    if (r.status === 'FULFILLED' && r.documentCount > 0) {
      actions.append(
        el('a', { class: 'btn btn--sm', href: apiUrl(`/requests/${encodeURIComponent(r._id)}/document`), download: '', text: 'Download document' })
      );
    }
    node.append(actions);
    return node;
  }

  // Answer a request that came back with a question: update the purpose if needed and resubmit.
  function resubmitForm(r) {
    const area = el('textarea', { class: 'input', maxlength: '500', 'aria-label': 'Updated purpose' });
    area.value = r.purpose;
    const err = el('div', { class: 'field-error', role: 'alert' });
    const send = el('button', { class: 'btn btn--sm', type: 'submit', text: 'Resubmit' });
    const f = el('form', { class: 'stack reject-form' }, area, err, send);
    f.addEventListener('submit', async (e) => {
      e.preventDefault();
      if (area.value.trim().length < 10) {
        err.textContent = 'Purpose must be at least 10 characters.';
        return;
      }
      send.disabled = true;
      try {
        await api(`/requests/${r._id}/resubmit`, { method: 'PATCH', body: { purpose: area.value } });
        showAlert(alertBox, 'Resubmitted. The reviewer will look at it again.', 'success');
      } catch (e2) {
        showAlert(alertBox, e2.errors?.map((x) => x.message).join(' ') || e2.message);
      }
      await load();
    });
    return f;
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
