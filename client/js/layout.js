import { api, el, ROLE_HOME, tpath } from './api.js';
import { applyBranding } from './branding.js';

applyBranding();

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

// Link to the notifications page with the unread count, refreshed every minute. A failed lookup just
// leaves the count off: it must never get in the way of the page.
function bell() {
  const count = el('span', { class: 'badge hidden', text: '0' });
  const link = el('a', { class: 'btn btn--ghost btn--sm', href: tpath('/notifications.html'), 'aria-label': 'Notifications' }, el('span', { text: 'Notifications ' }), count);
  const refresh = async () => {
    try {
      const { unreadCount } = await api('/notifications?unread=true&limit=1');
      count.textContent = unreadCount > 99 ? '99+' : String(unreadCount);
      count.classList.toggle('hidden', unreadCount === 0);
      link.setAttribute('aria-label', unreadCount ? `Notifications, ${unreadCount} unread` : 'Notifications');
    } catch (_e) {
      /* leave as is */
    }
  };
  refresh();
  setInterval(refresh, 60000);
  return link;
}

// Sidebar navigation per role. Paths only; the server still decides what each role may open.
const ICON = {
  home: ['M4 11.5 12 5l8 6.5', 'M6 10.5V19h12v-8.5'],
  verify: ['M12 3 4.5 6v5.5c0 4.2 3 7.4 7.5 8.5 4.5-1.1 7.5-4.3 7.5-8.5V6L12 3z', 'm9 12 2 2 4-4'],
  bell: ['M6 16V11a6 6 0 1 1 12 0v5l1.5 2h-15L6 16z', 'M10 20a2 2 0 0 0 4 0'],
  user: ['M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8z', 'M4.5 20a7.5 7.5 0 0 1 15 0'],
  log: ['M5 4h14v16H5z', 'M8.5 9h7M8.5 12.5h7M8.5 16h4'],
  chart: ['M5 19V10', 'M12 19V5', 'M19 19v-6'],
  plug: ['M9 3v5M15 3v5', 'M6 8h12v3a6 6 0 0 1-12 0V8z', 'M12 17v4'],
  gear: ['M12 15.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7z', 'M19 12a7 7 0 0 0-.1-1.2l2-1.5-2-3.5-2.3 1a7 7 0 0 0-2-1.2L14.2 3h-4l-.4 2.6a7 7 0 0 0-2 1.2l-2.3-1-2 3.5 2 1.5A7 7 0 0 0 5 12c0 .4 0 .8.1 1.2l-2 1.5 2 3.5 2.3-1c.6.5 1.3.9 2 1.2l.4 2.6h4l.4-2.6c.7-.3 1.4-.7 2-1.2l2.3 1 2-3.5-2-1.5c.1-.4.1-.8.1-1.2z'],
  mail: ['M4 6h16v12H4z', 'm4 7 8 6 8-6'],
};
function svgIcon(name) {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('class', 'nav-ico');
  for (const d of ICON[name]) {
    const p = document.createElementNS(ns, 'path');
    p.setAttribute('d', d);
    svg.append(p);
  }
  return svg;
}
function navItems(user) {
  const home = { icon: 'home', label: user.role === 'ADMIN' ? 'Users' : user.role === 'STUDENT' ? 'Home' : 'Dashboard', href: ROLE_HOME[user.role] };
  const extra = {
    STUDENT: [{ icon: 'verify', label: 'Verify document', href: tpath('/verify.html') }],
    PRINCIPAL: [{ icon: 'chart', label: 'Analytics', href: tpath('/analytics.html') }],
    ADMIN: [
      { icon: 'log', label: 'Audit trail', href: tpath('/admin/audit.html') },
      { icon: 'chart', label: 'Analytics', href: tpath('/analytics.html') },
      { icon: 'plug', label: 'Integrations', href: tpath('/admin/integrations.html') },
      { icon: 'gear', label: 'Settings', href: tpath('/admin/settings.html') },
      { icon: 'mail', label: 'E-mail delivery', href: tpath('/admin/notifications.html') },
    ],
  };
  return [home, ...(extra[user.role] || [])];
}
function sideNav(user) {
  const here = location.pathname.replace(/index\.html$/, '');
  const nav = el('nav', { class: 'side-nav', 'aria-label': 'Main' });
  for (const item of navItems(user)) {
    const a = el('a', { class: 'side-link', href: item.href }, svgIcon(item.icon), el('span', { text: item.label }));
    if (here === item.href.replace(/index\.html$/, '')) a.setAttribute('aria-current', 'page');
    nav.append(a);
  }
  return nav;
}

// Light/dark switch. The choice is remembered in this browser only (see /js/theme.js).
function themeToggle() {
  const btn = el('button', { class: 'btn btn--ghost btn--sm', type: 'button' });
  const isLight = () => document.documentElement.getAttribute('data-theme') === 'light';
  const sync = () => {
    btn.textContent = isLight() ? 'Dark mode' : 'Light mode';
    btn.setAttribute('aria-label', isLight() ? 'Switch to dark mode' : 'Switch to light mode');
  };
  btn.addEventListener('click', () => {
    const next = isLight() ? 'dark' : 'light';
    document.documentElement.setAttribute('data-theme', next);
    try {
      localStorage.setItem('docflow-theme', next);
    } catch (_e) {
      /* not remembered: still switched for this visit */
    }
    applyBranding();
    sync();
  });
  sync();
  return btn;
}

// A table wider than its card scrolls sideways. Keyboard users must be able to reach and scroll it,
// so each wrapper becomes a focusable, named region (axe: scrollable-region-focusable).
function makeTablesReachable() {
  for (const wrap of document.querySelectorAll('.table-wrap')) {
    if (wrap.hasAttribute('tabindex')) continue;
    const caption = wrap.querySelector('caption');
    wrap.setAttribute('tabindex', '0');
    wrap.setAttribute('role', 'region');
    wrap.setAttribute('aria-label', (caption && caption.textContent.trim()) || 'Table');
  }
}

function renderFooter() {
  if (document.querySelector('.site-footer')) return;
  const foot = el('footer', { class: 'site-footer', role: 'contentinfo' });
  for (const [text, page] of [['Terms', 'terms.html'], ['Privacy', 'privacy.html'], ['Support', 'support.html'], ['Status', 'status.html']]) foot.append(el('a', { href: tpath('/' + page), text }), ' ');
  document.body.append(foot);
}

function renderTopbar(user) {
  const host = document.getElementById('topbar');
  if (!host) return;
  renderFooter();
  makeTablesReachable();

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
    sideNav(user),
    el(
      'div',
      { class: 'nav-user' },
      el('span', { class: 'nav-user-name', text: user.name }),
      el('span', { class: 'badge', text: user.role }),
      user.department ? el('span', { class: 'muted', text: user.department }) : ''
    ),
    bell(),
    themeToggle(),
    el('a', { class: 'btn btn--ghost btn--sm', href: tpath('/account.html'), text: 'Account' }),
    logout
  );

  toggle.addEventListener('click', () => {
    const open = menu.classList.toggle('open');
    toggle.setAttribute('aria-expanded', String(open));
  });

  host.className = 'topbar';
  document.body.classList.add('has-sidebar');
  host.append(el('div', { class: 'container topbar-wrap' }, el('div', { class: 'topbar-inner' }, brand, toggle), menu));
  applyBranding(); // the brand link exists now: add the logo and the institution's name
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
