import { api } from './api.js';
import { showAlert, hideAlert } from './layout.js';

// The one-time token comes from the link. Take it out of the address bar and history straight away.
const params = new URLSearchParams(location.search);
const token = params.get('token') || '';
history.replaceState(null, '', location.pathname);

const form = document.getElementById('reset-form');
const alertBox = document.getElementById('form-alert');
const submit = document.getElementById('submit');

if (!token) {
  showAlert(alertBox, 'This link is incomplete. Use the link from your e-mail, or ask for a new one.');
} else {
  form.classList.remove('hidden');
}

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  hideAlert(alertBox);
  if (form.password.value !== form.confirm.value) {
    showAlert(alertBox, 'The two passwords do not match.');
    return;
  }
  submit.disabled = true;
  try {
    await api('/auth/reset-password', { method: 'POST', body: { token, password: form.password.value } });
    form.classList.add('hidden');
    showAlert(alertBox, 'Password updated. You can sign in now.', 'success');
  } catch (err) {
    showAlert(alertBox, err.errors?.map((x) => x.message).join(' ') || err.message);
    submit.disabled = false;
  }
});
