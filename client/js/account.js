import { api, ROLE_HOME, tpath, el } from './api.js';
import { requireUser, showAlert, hideAlert } from './layout.js';

const user = await requireUser(['STUDENT', 'CLERK', 'HOD', 'PRINCIPAL', 'ADMIN']);
if (user) init();

async function init() {
  document.getElementById('content').classList.remove('hidden');
  document.getElementById('back').href = ROLE_HOME[user.role];
  const alertBox = document.getElementById('page-alert');
  const say = (msg, type = 'error') => {
    showAlert(alertBox, msg, type);
    alertBox.scrollIntoView({ block: 'nearest' });
  };
  const fail = (err) => say(err.errors?.map((x) => x.message).join(' ') || err.message);

  let me = (await api('/auth/me'));
  const profile = document.getElementById('profile');
  const row = (k, v) => profile.append(el('dt', { text: k }), el('dd', { text: v }));
  row('Name', me.user.name);
  row('Email', me.user.email);
  row('Role', me.user.role);
  if (me.user.department) row('Department', me.user.department);
  row('E-mail verified', me.user.emailVerifiedAt ? 'Yes' : 'No');
  if (!me.user.emailVerifiedAt) {
    document.getElementById('verify-box').classList.remove('hidden');
    document.getElementById('resend').addEventListener('click', async (e) => {
      e.target.disabled = true;
      try {
        await api('/auth/resend-verification', { method: 'POST' });
        say('If your address still needs verifying, a new link has been sent.', 'success');
      } catch (err) {
        fail(err);
        e.target.disabled = false;
      }
    });
  }

  // ---- change password
  const pw = document.getElementById('password-form');
  pw.addEventListener('submit', async (e) => {
    e.preventDefault();
    hideAlert(alertBox);
    if (pw.newPassword.value !== pw.confirm.value) return say('The two new passwords do not match.');
    try {
      await api('/auth/change-password', { method: 'POST', body: { currentPassword: pw.currentPassword.value, newPassword: pw.newPassword.value } });
      pw.reset();
      say('Password changed. Other devices have been signed out.', 'success');
    } catch (err) {
      fail(err);
    }
  });

  // ---- two-step sign-in (staff only, and only if the server has a key)
  const section = document.getElementById('mfa-section');
  const staff = ['CLERK', 'HOD', 'PRINCIPAL', 'ADMIN'].includes(me.user.role);
  if (!staff || !me.mfaAvailable) return;
  section.classList.remove('hidden');
  const off = document.getElementById('mfa-off');
  const disableForm = document.getElementById('mfa-disable-form');
  const state = document.getElementById('mfa-state');

  function render() {
    state.textContent = me.user.mfaEnabled ? 'Two-step sign-in is ON for your account.' : 'Two-step sign-in is off. Turning it on protects your account if your password is ever stolen.';
    off.classList.toggle('hidden', me.user.mfaEnabled && document.getElementById('mfa-codes').classList.contains('hidden'));
    document.getElementById('mfa-start').classList.toggle('hidden', me.user.mfaEnabled);
    disableForm.classList.toggle('hidden', !me.user.mfaEnabled);
  }
  render();

  document.getElementById('mfa-start').addEventListener('click', async (e) => {
    e.target.disabled = true;
    try {
      const { secret, otpauthUrl } = await api('/auth/mfa/setup', { method: 'POST' });
      document.getElementById('mfa-secret').textContent = secret;
      document.getElementById('mfa-link').href = otpauthUrl;
      document.getElementById('mfa-setup').classList.remove('hidden');
    } catch (err) {
      fail(err);
      e.target.disabled = false;
    }
  });
  const enableForm = document.getElementById('mfa-enable-form');
  enableForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    hideAlert(alertBox);
    try {
      const { backupCodes } = await api('/auth/mfa/enable', { method: 'POST', body: { code: enableForm['enable-code'].value } });
      document.getElementById('mfa-codes-list').textContent = backupCodes.join('\n');
      document.getElementById('mfa-codes').classList.remove('hidden');
      document.getElementById('mfa-setup').classList.add('hidden');
      me.user.mfaEnabled = true;
      render();
      say('Two-step sign-in is on.', 'success');
    } catch (err) {
      fail(err);
    }
  });
  disableForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    hideAlert(alertBox);
    try {
      await api('/auth/mfa/disable', { method: 'POST', body: { password: disableForm['disable-password'].value, code: disableForm['disable-code'].value } });
      location.replace(tpath('/login.html'));
    } catch (err) {
      fail(err);
    }
  });
}
