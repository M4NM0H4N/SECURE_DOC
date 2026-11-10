// Public page behind the QR code. No sign-in, and it uses no shared session code: it only calls
// the two public verification endpoints of the institution named in the address.
const match = location.pathname.match(/^\/t\/([a-z0-9-]+)\//);
const slug = match ? match[1] : null;
const code = new URLSearchParams(location.search).get('code') || '';
history.replaceState(null, '', location.pathname + (code ? '?code=' + encodeURIComponent(code) : ''));

const lead = document.getElementById('lead');
const result = document.getElementById('result');
const check = document.getElementById('check');
const checkResult = document.getElementById('check-result');

function line(label, value) {
  const p = document.createElement('p');
  const b = document.createElement('strong');
  b.textContent = label + ': ';
  p.append(b, document.createTextNode(value));
  return p;
}
const STATUS = {
  VALID: ['This document is genuine and currently valid.', 'alert alert--success'],
  SUPERSEDED: ['This document was replaced by a newer version. Do not rely on it.', 'alert alert--warning'],
  REVOKED: ['This document has been withdrawn by the institution. Do not rely on it.', 'alert alert--error'],
};

async function call(path, options) {
  const res = await fetch('/api/t/' + slug + '/verify/' + encodeURIComponent(code) + path, {
    headers: { 'X-Requested-With': 'XMLHttpRequest', 'Content-Type': 'application/json' },
    credentials: 'omit',
    ...options,
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(body.message || 'Something went wrong'), { status: res.status });
  return body.data;
}

async function start() {
  if (!slug || !code) throw Object.assign(new Error('This link is incomplete.'), { status: 400 });
  const info = await call('', { method: 'GET' });
  lead.textContent = info.institution;
  const [text, cls] = STATUS[info.status] || ['Unknown status.', 'alert'];
  const banner = document.createElement('div');
  banner.className = cls;
  banner.textContent = text;
  result.replaceChildren(banner, line('Document', info.documentType || 'Official document'), line('Issued', new Date(info.issuedAt).toLocaleDateString(undefined, { dateStyle: 'long' })), line('Version', String(info.version)));
  result.classList.remove('hidden');
  check.classList.remove('hidden');
}
start().catch((err) => {
  lead.textContent = '';
  const banner = document.createElement('div');
  banner.className = 'alert alert--error';
  banner.textContent = err.status === 404 ? 'No document matches this code. It may be mistyped, or not issued by this institution.' : err.status === 503 ? 'Verification is not available right now.' : err.message;
  result.replaceChildren(banner);
  result.classList.remove('hidden');
});

// The file never leaves the device: it is hashed here and only the hash is sent.
document.getElementById('file').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  checkResult.className = 'hidden';
  try {
    const digest = await crypto.subtle.digest('SHA-256', await file.arrayBuffer());
    const hex = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
    const out = await call('/check', { method: 'POST', body: JSON.stringify({ sha256: hex }) });
    checkResult.className = out.matches && out.valid ? 'alert alert--success' : out.matches ? 'alert alert--warning' : 'alert alert--error';
    checkResult.textContent = out.matches
      ? out.valid ? 'This file is exactly the document the institution issued.' : 'This file is the document the institution issued, but it is no longer valid (replaced or withdrawn).'
      : 'This file is NOT the document the institution issued. It may have been altered or is a different file.';
  } catch (err) {
    checkResult.className = 'alert alert--error';
    checkResult.textContent = err.message;
  }
});
