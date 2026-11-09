import { api, el } from './api.js';
import { requireUser, showAlert, hideAlert } from './layout.js';
import { formatDate } from './format.js';

const me = await requireUser(['ADMIN']);
if (me) init();

function init() {
  document.getElementById('content').classList.remove('hidden');

  const dept = document.getElementById('department');
  dept.append(el('option', { value: '', text: 'Select department' }));
  api('/admin/departments')
    .then(({ items }) => {
      for (const d of items.filter((x) => x.isActive)) dept.append(el('option', { value: d.code, text: `${d.code} - ${d.name}` }));
    })
    .catch((err) => showAlert(document.getElementById('form-alert'), err.message));
  // A Principal is institution-wide: no department.
  const roleSel = document.getElementById('role');
  roleSel.addEventListener('change', () => {
    dept.disabled = roleSel.value === 'PRINCIPAL';
    if (dept.disabled) dept.value = '';
  });

  const form = document.getElementById('staff-form');
  const alertBox = document.getElementById('form-alert');
  const tbody = document.getElementById('user-rows');
  const state = document.getElementById('table-state');

  async function load() {
    tbody.replaceChildren();
    state.className = 'state';
    state.replaceChildren(el('div', { class: 'spinner' }), el('span', { text: 'Loading users...' }));
    try {
      const { items } = await api('/admin/users?limit=100');
      state.replaceChildren();
      if (!items.length) {
        state.textContent = 'No users yet.';
        return;
      }
      state.className = 'hidden';
      for (const u of items) tbody.append(row(u));
    } catch (err) {
      state.className = 'alert alert--error';
      state.textContent = err.message;
    }
  }

  function row(u) {
    const toggle = el('button', {
      class: 'btn btn--ghost btn--sm',
      type: 'button',
      text: u.isActive ? 'Deactivate' : 'Activate',
    });
    if (u._id === me._id) toggle.disabled = true;
    toggle.addEventListener('click', async () => {
      toggle.disabled = true;
      try {
        await api(`/admin/users/${u._id}`, { method: 'PATCH', body: { isActive: !u.isActive } });
        await load();
      } catch (err) {
        showAlert(alertBox, err.message);
        toggle.disabled = false;
      }
    });
    // Account tools (S3). Each is a plain server call; the server re-checks the Admin role and the institution.
    const tool = (text, path, done) => {
      const b = el('button', { class: 'btn btn--ghost btn--sm', type: 'button', text });
      b.addEventListener('click', async () => {
        hideAlert(alertBox);
        b.disabled = true;
        try {
          const data = await api(path, { method: 'POST' });
          done(data);
          await load();
        } catch (err) {
          showAlert(alertBox, err.message);
          b.disabled = false;
        }
      });
      return b;
    };
    const tools = [];
    if (u._id !== me._id) {
      tools.push(tool('Sign out everywhere', `/admin/users/${u._id}/sign-out`, () => showAlert(alertBox, 'All sessions ended.', 'success')));
      tools.push(tool('Reset link', `/admin/users/${u._id}/reset-link`, (d) => showLink(`Password reset link for ${u.email}. It works once, for one hour.`, d.link)));
    }
    if (u.locked) tools.push(tool('Unlock', `/admin/users/${u._id}/unlock`, () => showAlert(alertBox, 'Account unlocked.', 'success')));
    if (u.role === 'STUDENT' && !u.emailVerifiedAt) tools.push(tool('Mark verified', `/admin/users/${u._id}/verify-email`, () => showAlert(alertBox, 'Marked as verified.', 'success')));
    return el(
      'tr',
      {},
      el('td', { text: u.name }),
      el('td', { text: u.email }),
      el('td', {}, el('span', { class: 'badge', text: u.role })),
      el('td', { text: u.department || '-' }),
      el(
        'td',
        {},
        el('span', { class: `badge badge--${u.isActive ? 'active' : 'inactive'}`, text: u.isActive ? 'Active' : 'Inactive' }),
        u.locked ? el('span', { class: 'badge badge--rejected', text: 'Locked' }) : '',
        u.mfaEnabled ? el('span', { class: 'badge', text: '2-step' }) : ''
      ),
      el('td', {}, el('div', { class: 'actions' }, toggle, ...tools))
    );
  }

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    hideAlert(alertBox);
    const submit = document.getElementById('submit');
    submit.disabled = true;
    try {
      const { invite, link } = await api('/admin/invites', {
        method: 'POST',
        body: {
          name: form.elements.name.value || undefined,
          email: form.email.value,
          role: form.role.value,
          department: form.role.value === 'PRINCIPAL' ? undefined : form.department.value,
        },
      });
      form.reset();
      dept.disabled = false;
      showLink(`Invitation created for ${invite.email}. It works once and expires in 7 days.`, link);
      await loadInvites();
    } catch (err) {
      const detail = err.errors?.map((x) => x.message).join(' ');
      showAlert(alertBox, detail || err.message);
    } finally {
      submit.disabled = false;
    }
  });

  // The link is shown only now: it is not stored in readable form and never listed again.
  const linkBox = document.getElementById('link-box');
  const linkValue = document.getElementById('link-value');
  function showLink(note, link) {
    document.getElementById('link-note').textContent = note;
    linkValue.value = link;
    linkBox.classList.remove('hidden');
    linkBox.scrollIntoView({ block: 'nearest' });
  }
  document.getElementById('link-copy').addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(linkValue.value);
      showAlert(alertBox, 'Link copied.', 'success');
    } catch (_e) {
      linkValue.select();
    }
  });

  const inviteRows = document.getElementById('invite-rows');
  async function loadInvites() {
    const { items } = await api('/admin/invites');
    inviteRows.replaceChildren(
      ...items.map((i) => {
        const open = i.status === 'PENDING' || i.status === 'EXPIRED';
        const act = (text, path, method) => {
          const b = el('button', { class: 'btn btn--ghost btn--sm', type: 'button', text });
          b.addEventListener('click', async () => {
            b.disabled = true;
            try {
              const data = await api(path, { method });
              if (data && data.link) showLink(`New invitation link for ${i.email}. The old one no longer works.`, data.link);
              await loadInvites();
            } catch (err) {
              showAlert(alertBox, err.message);
              b.disabled = false;
            }
          });
          return b;
        };
        return el(
          'tr',
          {},
          el('td', { text: i.email }),
          el('td', {}, el('span', { class: 'badge', text: i.role })),
          el('td', { text: i.department || '-' }),
          el('td', {}, el('span', { class: 'badge', text: i.status })),
          el('td', { text: formatDate(i.expiresAt) }),
          el('td', {}, open ? el('div', { class: 'actions' }, act('Resend', `/admin/invites/${i._id}/resend`, 'POST'), act('Revoke', `/admin/invites/${i._id}`, 'DELETE')) : '')
        );
      })
    );
  }

  load();
  loadInvites().catch((err) => showAlert(alertBox, err.message));
}
