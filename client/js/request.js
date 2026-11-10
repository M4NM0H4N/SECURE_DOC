import { api, el, ROLE_HOME, apiUrl } from './api.js';
import { statusBadge, formatDate, STATUS_LABELS } from './format.js';
import { drawQr } from './qr.js';
import { requireUser } from './layout.js';

const user = await requireUser(['STUDENT', 'CLERK', 'HOD', 'PRINCIPAL', 'ADMIN']);
if (user) init();

async function init() {
  const root = document.getElementById('detail');
  document.getElementById('back').href = ROLE_HOME[user.role];

  const fail = (msg) => root.replaceChildren(el('div', { class: 'alert alert--error', text: msg }));

  const id = new URLSearchParams(location.search).get('id');
  if (!id) return fail('No request selected.');

  let request = null;
  try {
    ({ request } = await api(`/requests/${encodeURIComponent(id)}`));
    const r = request;
    root.replaceChildren(
      el('div', { class: 'req-head' }, el('h1', { text: r.documentType }), statusBadge(r.status)),
      el(
        'dl',
        { class: 'meta' },
        ...row('Purpose', r.purpose),
        ...row('Student', r.studentId ? `${r.studentId.name} (${r.studentId.email})` : '-'),
        ...row('Department', r.department),
        ...(r.currentStep ? row('Waiting on', r.currentStep) : []),
        ...row('Submitted', formatDate(r.createdAt)),
        ...row('Last updated', formatDate(r.updatedAt))
      ),
      r.status === 'REJECTED' && r.rejectionReason
        ? el('div', { class: 'alert alert--error', text: `Rejection reason: ${r.rejectionReason}` })
        : '',
      el('h2', { text: 'History' }),
      timeline(r.statusHistory)
    );
  } catch (err) {
    fail(err.status === 404 ? 'Request not found.' : err.message);
    return;
  }
  // Documents (S4): Admin and Principal never see them (the server answers 403 anyway).
  const r = request;
  if (r && ['STUDENT', 'CLERK', 'HOD'].includes(user.role) && r.status === 'FULFILLED') showDocuments(r);
}

const sizeText = (b) => (b < 1024 * 1024 ? `${Math.max(1, Math.round(b / 1024))} KB` : `${(b / 1024 / 1024).toFixed(1)} MB`);

async function showDocuments(r) {
  const box = document.getElementById('documents');
  const list = document.getElementById('document-list');
  const tools = document.getElementById('document-tools');
  const note = document.getElementById('documents-note');
  box.classList.remove('hidden');
  const say = (msg, type = 'error') => {
    note.className = `alert alert--${type}`;
    note.textContent = msg;
  };
  const fail = (err) => say(err.errors?.map((x) => x.message).join(' ') || err.message);
  const clerk = user.role === 'CLERK';

  async function load() {
    list.replaceChildren(el('div', { class: 'state' }, el('div', { class: 'spinner' }), el('span', { text: 'Loading documents...' })));
    const { items } = await api(`/requests/${encodeURIComponent(r._id)}/documents`);
    list.replaceChildren();
    if (!items.length) list.append(el('p', { class: 'muted', text: 'There are no documents.' }));
    for (const d of items) list.append(card(d));
    note.className = 'muted';
    note.textContent = clerk
      ? 'Replacing creates a new version; revoking withdraws a document and stays in the history.'
      : 'Download your official documents. Anyone can check one is genuine with its QR code or link.';
  }

  function card(d) {
    const active = d.status === 'ACTIVE';
    const node = el(
      'article',
      { class: 'card stack' },
      el('div', { class: 'req-head' }, el('h3', { text: `${r.documentType} · version ${d.version}` }), el('span', { class: `badge badge--${active ? 'active' : 'inactive'}`, text: d.status === 'ACTIVE' ? 'Active' : d.status === 'REPLACED' ? 'Replaced' : 'Revoked' })),
      el('p', { class: 'muted', text: `${d.fileType.toUpperCase()} · ${sizeText(d.sizeBytes)} · ${formatDate(d.createdAt)}` })
    );
    if (d.status === 'REVOKED' && d.revokedReason) node.append(el('p', { class: 'alert alert--error', text: `Revoked: ${d.revokedReason}` }));
    if (active) {
      node.append(el('div', { class: 'actions' }, el('a', { class: 'btn btn--sm', href: apiUrl(`/requests/${encodeURIComponent(r._id)}/documents/${encodeURIComponent(d._id)}/file`), download: '', text: 'Download' })));
      if (d.verifyUrl) node.append(verifyBlock(d.verifyUrl));
      if (clerk) node.append(clerkTools(d));
    }
    return node;
  }

  // The QR code and link anyone can use to check this document is genuine and still valid.
  function verifyBlock(url) {
    const input = el('input', { class: 'input', readonly: '', value: url, 'aria-label': 'Verification link' });
    const copy = el('button', { class: 'btn btn--ghost btn--sm', type: 'button', text: 'Copy link' });
    copy.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(url);
        say('Verification link copied.', 'success');
      } catch (_e) {
        input.select();
      }
    });
    return el('div', { class: 'stack' }, el('strong', { text: 'Verification' }), drawQr(url), input, copy);
  }

  function pickFile(label, onFile, buttonText, cls = 'btn btn--sm') {
    const input = el('input', { class: 'input', type: 'file', accept: '.pdf,.png,.jpg,.jpeg,application/pdf,image/png,image/jpeg', 'aria-label': label });
    const go = el('button', { class: cls, type: 'button', text: buttonText });
    go.addEventListener('click', async () => {
      const file = input.files[0];
      if (!file) return say('Choose a file first.');
      if (file.size > 5 * 1024 * 1024) return say('File is larger than 5 MB.');
      go.disabled = true;
      try {
        const data = new FormData();
        data.append('document', file);
        await onFile(data);
        await load();
      } catch (err) {
        fail(err);
      } finally {
        go.disabled = false;
      }
    });
    return el('div', { class: 'stack' }, input, go);
  }

  function clerkTools(d) {
    const replace = pickFile('New version of this document (PDF, JPG or PNG, max 5 MB)', (data) => api(`/requests/${encodeURIComponent(r._id)}/documents/${encodeURIComponent(d._id)}/replace`, { method: 'POST', body: data }), 'Replace with a new version', 'btn btn--ghost btn--sm');
    const reason = el('input', { class: 'input', maxlength: '500', placeholder: 'Reason for revoking (required)', 'aria-label': 'Reason for revoking' });
    const revoke = el('button', { class: 'btn btn--danger btn--sm', type: 'button', text: 'Revoke' });
    revoke.addEventListener('click', async () => {
      if (reason.value.trim().length < 5) return say('Please give a reason (at least 5 characters).');
      revoke.disabled = true;
      try {
        await api(`/requests/${encodeURIComponent(r._id)}/documents/${encodeURIComponent(d._id)}`, { method: 'DELETE', body: { reason: reason.value } });
        await load();
      } catch (err) {
        fail(err);
        revoke.disabled = false;
      }
    });
    return el('div', { class: 'stack' }, replace, el('div', { class: 'stack' }, reason, revoke));
  }

  if (clerk) {
    tools.classList.remove('hidden');
    tools.append(el('h3', { text: 'Add another document' }), pickFile('Another document (PDF, JPG or PNG, max 5 MB)', (data) => api(`/requests/${encodeURIComponent(r._id)}/documents`, { method: 'POST', body: data }), 'Upload'));
  }
  await load().catch(fail);
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
        h.step ? el('span', { class: 'muted', text: ` (${h.step})` }) : '',
        el('span', { class: 'muted', text: ` · ${formatDate(h.at)}${h.by ? ` · ${h.by.name}` : ''}` }),
        h.note ? el('div', { class: 'hint', text: h.note }) : ''
      )
    );
  }
  return ol;
}
