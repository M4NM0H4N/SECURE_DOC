// Public status page: asks /readyz and shows booleans only.
const line = document.getElementById('status-line');
const list = document.getElementById('status-checks');
const LABELS = { database: 'Database', worker: 'Background worker (e-mail and reminders)' };

async function check() {
  try {
    const res = await fetch('/readyz', { cache: 'no-store' });
    const body = await res.json();
    line.className = res.ok ? 'alert alert--success' : 'alert alert--error';
    line.textContent = res.ok ? 'All systems operational.' : 'Some parts of the service are not available right now.';
    list.replaceChildren(...Object.entries(body.checks || {}).map(([k, v]) => {
      const li = document.createElement('li');
      li.textContent = (LABELS[k] || k) + ': ' + (v ? 'OK' : 'not responding');
      return li;
    }));
  } catch (_e) {
    line.className = 'alert alert--error';
    line.textContent = 'The service could not be reached.';
    list.replaceChildren();
  }
  document.getElementById('status-time').textContent = 'Checked ' + new Date().toLocaleTimeString() + '.';
}
check();
setInterval(check, 30000);
