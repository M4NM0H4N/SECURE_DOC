import { api, el } from './api.js';
import { requireUser, showAlert, hideAlert } from './layout.js';

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
    return el(
      'tr',
      {},
      el('td', { text: u.name }),
      el('td', { text: u.email }),
      el('td', {}, el('span', { class: 'badge', text: u.role })),
      el('td', { text: u.department || '-' }),
      el('td', {}, el('span', { class: `badge badge--${u.isActive ? 'active' : 'inactive'}`, text: u.isActive ? 'Active' : 'Inactive' })),
      el('td', {}, toggle)
    );
  }

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    hideAlert(alertBox);
    const submit = document.getElementById('submit');
    submit.disabled = true;
    try {
      await api('/admin/users', {
        method: 'POST',
        body: {
          name: form.elements.name.value,
          email: form.email.value,
          password: form.password.value,
          role: form.role.value,
          department: form.department.value,
        },
      });
      form.reset();
      showAlert(alertBox, 'Staff account created.', 'success');
      await load();
    } catch (err) {
      const detail = err.errors?.map((x) => x.message).join(' ');
      showAlert(alertBox, detail || err.message);
    } finally {
      submit.disabled = false;
    }
  });

  load();
}
