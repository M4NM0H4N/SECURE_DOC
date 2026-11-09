import { api } from './api.js';
import { showAlert, hideAlert } from './layout.js';

const form = document.getElementById('forgot-form');
const alertBox = document.getElementById('form-alert');
const submit = document.getElementById('submit');

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  hideAlert(alertBox);
  submit.disabled = true;
  try {
    // The server gives the same answer for every address, so we can say it plainly.
    await api('/auth/forgot-password', { method: 'POST', body: { email: form.email.value } });
    showAlert(alertBox, 'If that address has an account, a reset link is on its way. It works once and expires in one hour.', 'success');
    form.classList.add('hidden');
  } catch (err) {
    showAlert(alertBox, err.errors?.map((x) => x.message).join(' ') || (err.status === 429 ? 'Too many attempts. Try again later.' : err.message));
    submit.disabled = false;
  }
});
