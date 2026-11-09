import { api, ROLE_HOME, el } from './api.js';
import { showAlert, hideAlert } from './layout.js';

const form = document.getElementById('register-form');
const alertBox = document.getElementById('form-alert');
const submit = document.getElementById('submit');
const dept = document.getElementById('department');

dept.append(el('option', { value: '', text: 'Select department' }));
api('/meta/departments')
  .then(({ items }) => {
    for (const d of items) dept.append(el('option', { value: d.code, text: `${d.code} - ${d.name}` }));
  })
  .catch(() => showAlert(alertBox, 'Could not load the department list. Please reload the page.'));

function clearFieldErrors() {
  form.querySelectorAll('.field-error').forEach((n) => (n.textContent = ''));
}

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  hideAlert(alertBox);
  clearFieldErrors();
  submit.disabled = true;
  submit.textContent = 'Creating account...';
  try {
    // Role is never sent: the server always creates a Student.
    await api('/auth/register', {
      method: 'POST',
      body: {
        name: form.elements.name.value,
        email: form.email.value,
        password: form.password.value,
        department: form.department.value,
      },
    });
    const { user } = await api('/auth/login', {
      method: 'POST',
      body: { email: form.email.value, password: form.password.value },
    });
    location.replace(ROLE_HOME[user.role]);
  } catch (err) {
    for (const fe of err.errors || []) {
      const slot = document.getElementById(`err-${fe.field}`);
      if (slot && !slot.textContent) slot.textContent = fe.message;
    }
    showAlert(alertBox, err.errors?.length ? 'Please fix the highlighted fields.' : err.message);
    submit.disabled = false;
    submit.textContent = 'Create account';
  }
});
