import { api } from './api.js';
import { showAlert } from './layout.js';

// The one-time token comes from the link. Take it out of the address bar and history straight away.
const params = new URLSearchParams(location.search);
const token = params.get('token') || '';
history.replaceState(null, '', location.pathname);

const lead = document.getElementById('lead');
const alertBox = document.getElementById('form-alert');

(async () => {
  try {
    if (!token) throw new Error('This link is incomplete. Use the link from your e-mail.');
    await api('/auth/verify-email', { method: 'POST', body: { token } });
    lead.textContent = '';
    showAlert(alertBox, 'Your e-mail address is verified. Thank you.', 'success');
  } catch (err) {
    lead.textContent = '';
    showAlert(alertBox, err.errors?.map((x) => x.message).join(' ') || err.message);
  }
})();
