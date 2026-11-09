import { api, ROLE_HOME } from './api.js';
import { showAlert, hideAlert } from './layout.js';

const form = document.getElementById('login-form');
const alertBox = document.getElementById('form-alert');
const submit = document.getElementById('submit');
const mfaForm = document.getElementById('mfa-form');
let challenge = '';

if (new URLSearchParams(location.search).get('reason') === 'deactivated') {
  showAlert(alertBox, 'Your account has been deactivated. Please contact the administrator.');
}

// Already signed in? Go straight to the right dashboard.
api('/auth/me')
  .then(({ user }) => location.replace(ROLE_HOME[user.role]))
  .catch(() => {});

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  hideAlert(alertBox);
  submit.disabled = true;
  submit.textContent = 'Signing in...';
  try {
    const data = await api('/auth/login', {
      method: 'POST',
      body: { email: form.email.value, password: form.password.value },
    });
    if (data.mfaRequired) {
      // Password accepted; ask for the second factor. The challenge only lives in memory.
      challenge = data.challenge;
      form.classList.add('hidden');
      mfaForm.classList.remove('hidden');
      mfaForm.code.focus();
      return;
    }
    location.replace(ROLE_HOME[data.user.role]);
  } catch (err) {
    showAlert(alertBox, err.status === 429 ? 'Too many attempts. Try again later.' : err.message);
    submit.disabled = false;
    submit.textContent = 'Sign in';
  }
});

mfaForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  hideAlert(alertBox);
  const button = document.getElementById('mfa-submit');
  button.disabled = true;
  try {
    const { user } = await api('/auth/login/mfa', { method: 'POST', body: { challenge, code: mfaForm.code.value } });
    location.replace(ROLE_HOME[user.role]);
  } catch (err) {
    showAlert(alertBox, err.errors?.map((x) => x.message).join(' ') || (err.status === 429 ? 'Too many attempts. Try again later.' : err.message));
    button.disabled = false;
    if (/expired|start again/i.test(err.message)) {
      // The challenge is gone (or the account is locked): back to the password step.
      mfaForm.classList.add('hidden');
      form.classList.remove('hidden');
      submit.disabled = false;
      submit.textContent = 'Sign in';
    }
  }
});
