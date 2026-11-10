import { api, el, ROLE_HOME, tpath } from './api.js';
import { formatDate } from './format.js';
import { requireUser, showAlert, hideAlert } from './layout.js';

const user = await requireUser(['STUDENT', 'CLERK', 'HOD', 'PRINCIPAL', 'ADMIN']);
if (user) init();

async function init() {
  document.getElementById('content').classList.remove('hidden');
  document.getElementById('back').href = ROLE_HOME[user.role];
  const alertBox = document.getElementById('page-alert');
  const list = document.getElementById('list');
  const state = document.getElementById('list-state');
  const more = document.getElementById('more');
  const onlyUnread = document.getElementById('only-unread');
  let page = 1;

  // E-mail preference (only meaningful when the server sends mail at all).
  const pref = document.getElementById('email-pref');
  try {
    const p = await api('/notifications/preferences');
    pref.checked = p.email;
    if (!p.mailAvailable) {
      pref.disabled = true;
      document.getElementById('pref-hint').textContent = 'E-mail is not switched on for this installation yet, so you will only see notifications here.';
    }
  } catch (err) {
    showAlert(alertBox, err.message);
  }
  pref.addEventListener('change', async () => {
    hideAlert(alertBox);
    try {
      await api('/notifications/preferences', { method: 'PATCH', body: { email: pref.checked } });
      showAlert(alertBox, 'Saved.', 'success');
    } catch (err) {
      pref.checked = !pref.checked;
      showAlert(alertBox, err.message);
    }
  });

  function card(n) {
    const unread = !n.readAt;
    const open = el('button', { class: 'btn btn--ghost btn--sm', type: 'button', text: n.requestId ? 'Open request' : 'Mark as read' });
    open.addEventListener('click', async () => {
      try {
        if (unread) await api(`/notifications/${n._id}/read`, { method: 'POST' });
      } catch (_e) {
        /* still go where the person wanted */
      }
      if (n.requestId) location.assign(tpath(`/request.html?id=${encodeURIComponent(n.requestId)}`));
      else load();
    });
    return el(
      'article',
      { class: 'card stack' },
      el('div', { class: 'req-head' }, el('h3', { text: n.title }), unread ? el('span', { class: 'badge', text: 'New' }) : ''),
      el('p', { text: n.body }),
      el('p', { class: 'hint', text: formatDate(n.createdAt) }),
      el('div', { class: 'actions' }, open)
    );
  }

  async function load({ append = false } = {}) {
    if (append) page += 1;
    else {
      page = 1;
      list.replaceChildren();
    }
    try {
      const qs = new URLSearchParams({ limit: '20', page: String(page) });
      if (onlyUnread.checked) qs.set('unread', 'true');
      const { items, total } = await api(`/notifications?${qs}`);
      state.className = items.length || append ? 'hidden' : 'state';
      if (!items.length && !append) state.textContent = 'Nothing here yet.';
      for (const n of items) list.append(card(n));
      more.classList.toggle('hidden', list.children.length >= total);
    } catch (err) {
      showAlert(alertBox, err.message);
    }
  }
  more.addEventListener('click', () => load({ append: true }));
  onlyUnread.addEventListener('change', () => load());
  document.getElementById('mark-all').addEventListener('click', async () => {
    try {
      await api('/notifications/read-all', { method: 'POST' });
      await load();
    } catch (err) {
      showAlert(alertBox, err.message);
    }
  });
  load();
}
