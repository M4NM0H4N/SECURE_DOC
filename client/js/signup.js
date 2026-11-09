// Institution signup (platform level, not tied to a tenant). Same alert/field-error pattern as register.js.
const form = document.getElementById('signup-form');
const alertBox = document.getElementById('form-alert');
const submit = document.getElementById('submit');

function showAlert(msg) {
  alertBox.textContent = msg;
  alertBox.className = 'alert alert--error';
  alertBox.classList.remove('hidden');
}

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  alertBox.classList.add('hidden');
  form.querySelectorAll('.field-error').forEach((n) => (n.textContent = ''));
  submit.disabled = true;
  submit.textContent = 'Creating...';
  const body = {};
  for (const k of ['institutionName', 'slug', 'adminName', 'adminEmail', 'adminPassword', 'signupKey']) {
    body[k] = form.elements[k].value;
  }
  try {
    const res = await fetch('/api/platform/signup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
      credentials: 'same-origin',
      body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      for (const fe of data.errors || []) {
        const slot = document.getElementById('err-' + fe.field);
        if (slot && !slot.textContent) slot.textContent = fe.message;
      }
      showAlert(data.errors && data.errors.length ? 'Please fix the highlighted fields.' : data.message || 'Something went wrong');
      submit.disabled = false;
      submit.textContent = 'Create institution';
      return;
    }
    location.replace('/t/' + data.data.tenant.slug + '/login.html');
  } catch (_err) {
    showAlert('Network error. Please check your connection.');
    submit.disabled = false;
    submit.textContent = 'Create institution';
  }
});
