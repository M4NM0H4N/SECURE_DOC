import { api, el, ROLE_HOME, tpath } from './api.js';

const LOGO =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3 4 6v6c0 4.5 3.2 7.8 8 9 4.8-1.2 8-4.5 8-9V6l-8-3z"/><path d="m9 12 2 2 4-4"/></svg>';

// Guards a page: redirects to login if unauthenticated, or to the user's own
// home if their role is not allowed. UI only - the backend enforces access.
export async function requireUser(allowedRoles) {
  let user;
  try {
    ({ user } = await api('/auth/me'));
  } catch (e) {
    location.replace(e && e.status === 403 ? tpath('/login.html?reason=deactivated') : tpath('/login.html'));
    return null;
  }
  if (!allowedRoles.includes(user.role)) {
    location.replace(ROLE_HOME[user.role] || tpath('/login.html'));
    return null;
  }
  renderTopbar(user);
  return user;
}

function renderTopbar(user) {
  const host = document.getElementById('topbar');
  if (!host) return;

  const brand = el('a', { class: 'brand', href: ROLE_HOME[user.role] });
  // Static trusted SVG constant (no user data).
  brand.insertAdjacentHTML('afterbegin', LOGO);
  brand.append(el('span', { text: 'DocFlow' }));

  const toggle = el('button', {
    class: 'btn btn--ghost nav-toggle',
    type: 'button',
    'aria-expanded': 'false',
    'aria-controls': 'nav-menu',
    text: 'Menu',
  });

  const logout = el('button', { class: 'btn btn--ghost btn--sm', type: 'button', text: 'Log out' });
  logout.addEventListener('click', async () => {
    try {
      await api('/auth/logout', { method: 'POST' });
    } finally {
      location.replace(tpath('/login.html'));
    }
  });

  const menu = el(
    'div',
    { class: 'nav-menu', id: 'nav-menu' },
    el(
      'div',
      { class: 'nav-user' },
      el('span', { class: 'nav-user-name', text: user.name }),
      el('span', { class: 'badge', text: user.role }),
      user.department ? el('span', { class: 'muted', text: user.department }) : ''
    ),
    el('a', { class: 'btn btn--ghost btn--sm', href: tpath('/account.html'), text: 'Account' }),
    logout
  );

  toggle.addEventListener('click', () => {
    const open = menu.classList.toggle('open');
    toggle.setAttribute('aria-expanded', String(open));
  });

  host.className = 'topbar';
  host.append(el('div', { class: 'container topbar-wrap' }, el('div', { class: 'topbar-inner' }, brand, toggle), menu));
}

export function showAlert(container, message, type = 'error') {
  container.className = `alert alert--${type}`;
  container.textContent = message;
  container.classList.remove('hidden');
}

export function hideAlert(container) {
  container.classList.add('hidden');
  container.textContent = '';
}
