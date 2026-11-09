import { api } from './api.js';
import { showAlert, hideAlert } from './layout.js';

// The one-time token comes from the link. Take it out of the address bar and history straight away.
const params = new URLSearchParams(location.search);
const token = params.get('token') || '';
history.replaceState(null, '', location.pathname);

const ROLES = { CLERK: 'Clerk', HOD: 'Head of Department', PRINCIPAL: 'Principal' };
const form = document.getElementById('invite-form');
const alertBox = document.getElementById('form-alert');
const lead = document.getElementById('lead');
const submit = document.getElementById('submit');

async function start() {
  if (!token) throw new Error('This link is incomplete. Ask your administrator for a new invitation.');
  const { invite, institution } = await api(`/auth/invite?token=${encodeURIComponent(token)}`);
  lead.textContent = `You have been invited to ${institution}.`;
  document.getElementById('invite-summary').textContent =
    `Account for ${invite.email} as ${ROLES[invite.role] || invite.role}${invite.department ? ` (${invite.department})` : ''}.`;
  if (invite.name) form.name.value = invite.name;
  form.classList.remove('hidden');
}
start().catch((err) => {
  lead.textContent = '';
  showAlert(alertBox, err.message || 'This link is invalid or has expired.');
});

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  hideAlert(alertBox);
  if (form.password.value !== form.confirm.value) {
    showAlert(alertBox, 'The two passwords do not match.');
    return;
  }
  submit.disabled = true;
  try {
    await api('/auth/accept-invite', { method: 'POST', body: { token, name: form.name.value, password: form.password.value } });
    form.classList.add('hidden');
    lead.textContent = '';
    showAlert(alertBox, 'Your account is ready. You can sign in now.', 'success');
  } catch (err) {
    showAlert(alertBox, err.errors?.map((x) => x.message).join(' ') || err.message);
    submit.disabled = false;
  }
});
