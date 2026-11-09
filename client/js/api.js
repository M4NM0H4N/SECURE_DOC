// Thin fetch wrapper. Sends the CSRF header; auth cookie is HttpOnly (not readable here).
export const DEPARTMENTS = ['CSE', 'ME', 'CIVIL', 'ECE', 'EEE'];

// The institution comes from the page address: /t/<slug>/... Without it there is nothing to
// talk to, so go to the institution chooser.
const match = location.pathname.match(/^\/t\/([a-z0-9-]+)(?:\/|$)/);
export const SLUG = match ? match[1] : null;
if (!SLUG) location.replace('/');
export const tpath = (p) => `/t/${SLUG}${p}`;
export const apiUrl = (p) => `/api/t/${SLUG}${p}`;

export const ROLE_HOME = {
  STUDENT: tpath('/student/'),
  CLERK: tpath('/clerk/'),
  HOD: tpath('/hod/'),
  ADMIN: tpath('/admin/'),
};

export async function api(path, { method = 'GET', body } = {}) {
  const headers = { 'X-Requested-With': 'XMLHttpRequest' };
  const opts = { method, headers, credentials: 'same-origin' };
  if (body instanceof FormData) {
    // Let the browser set the multipart boundary itself.
    opts.body = body;
  } else if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  let res;
  try {
    res = await fetch(apiUrl(path), opts);
  } catch (_e) {
    throw Object.assign(new Error('Network error. Please check your connection.'), { status: 0 });
  }
  let data = {};
  try {
    data = await res.json();
  } catch (_e) {
    /* non-JSON response */
  }
  // Account deactivated while signed in: leave immediately and say why.
  if (res.status === 403 && data.message === 'Account is deactivated' && !path.startsWith('/auth/')) {
    location.replace(tpath('/login.html?reason=deactivated'));
    throw Object.assign(new Error(data.message), { status: 403 });
  }
  // Session expired or cleared mid-use: go back to login (auth endpoints handle their own 401s).
  if (res.status === 401 && !path.startsWith('/auth/')) {
    location.replace(tpath('/login.html'));
    throw Object.assign(new Error('Your session has expired. Please sign in again.'), { status: 401 });
  }
  if (!res.ok) {
    const err = new Error(data.message || 'Something went wrong');
    err.status = res.status;
    err.errors = data.errors || [];
    throw err;
  }
  return data.data;
}

// Escape-free DOM helper: always uses textContent, never innerHTML.
export function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v);
  }
  for (const c of children) node.append(c);
  return node;
}
