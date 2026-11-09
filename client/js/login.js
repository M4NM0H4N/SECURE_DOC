import { api, ROLE_HOME } from './api.js';
import { showAlert, hideAlert } from './layout.js';

const form = document.getElementById('login-form');
const alertBox = document.getElementById('form-alert');
const submit = document.getElementById('submit');

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
    const { user } = await api('/auth/login', {
      method: 'POST',
      body: { email: form.email.value, password: form.password.value },
    });
    location.replace(ROLE_HOME[user.role]);
  } catch (err) {
    showAlert(alertBox, err.status === 429 ? 'Too many attempts. Try again later.' : err.message);
    submit.disabled = false;
    submit.textContent = 'Sign in';
  }
});
