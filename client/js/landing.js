// Interactive parts of the landing page. Everything here is progressive: the page reads fine without it,
// it never inserts HTML strings (DOM methods only), and animation is skipped when "reduce motion" is on.
import { applyBranding } from './branding.js';

const match = location.pathname.match(/^\/t\/([a-z0-9-]+)(?:\/|$)/);
const slug = match ? match[1] : null;
const $ = (id) => document.getElementById(id);
const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

function node(tag, props = {}, text) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) n.setAttribute(k, v);
  if (text !== undefined) n.textContent = text;
  return n;
}

// ---- light / dark switch (the signed-in pages have the same one in the side bar)
function themeButton() {
  const btn = $('theme-btn');
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
}

// ---- sections slide in as they come into view (transform only, so text is never invisible)
function revealOnScroll() {
  const items = document.querySelectorAll('.reveal');
  if (reduceMotion || !('IntersectionObserver' in window)) {
    for (const el of items) el.classList.add('in');
    return;
  }
  document.documentElement.classList.add('anim');
  const io = new IntersectionObserver(
    (entries) => {
      for (const e of entries) {
        if (e.isIntersecting) {
          e.target.classList.add('in');
          io.unobserve(e.target);
        }
      }
    },
    { threshold: 0.12 }
  );
  for (const el of items) io.observe(el);
}

// ---- the glass stack tilts a little with the pointer (mouse only)
function heroTilt() {
  const art = $('hero-art');
  const svg = art && art.querySelector('.stack-art');
  if (!svg || reduceMotion) return;
  art.addEventListener('pointermove', (e) => {
    if (e.pointerType !== 'mouse') return;
    const r = art.getBoundingClientRect();
    const x = (e.clientX - r.left) / r.width - 0.5;
    const y = (e.clientY - r.top) / r.height - 0.5;
    svg.style.setProperty('--ry', (x * 14).toFixed(1) + 'deg');
    svg.style.setProperty('--rx', (-y * 10).toFixed(1) + 'deg');
  });
  art.addEventListener('pointerleave', () => {
    svg.style.setProperty('--ry', '0deg');
    svg.style.setProperty('--rx', '0deg');
  });
}

// ---- the example request that walks through the workflow
const STAGES = ['Submitted', 'Review', 'Approved', 'Issued'];
const STEPS = [
  { status: 'pending', label: 'Pending', text: 'The student submits a request and states the purpose. It is logged at once, with the time and who made it.', layers: 1 },
  { status: 'under_review', label: 'Under review', text: 'A clerk of the student\'s own department checks the request and moves it to the head of department.', layers: 2 },
  { status: 'approved', label: 'Approved', text: 'The head of department approves. A rejection would need a written reason that the student can read.', layers: 2 },
  { status: 'fulfilled', label: 'Fulfilled', text: 'The clerk uploads the official document. A verification code and QR are created, so anyone can check it.', layers: 3 },
];
function demo() {
  const buttons = [...document.querySelectorAll('.demo-step')];
  const badge = $('demo-badge');
  const track = $('demo-track');
  const text = $('demo-text');
  let current = 0;
  let timer = null;
  let userChose = false;

  function show(i) {
    current = i;
    const s = STEPS[i];
    buttons.forEach((b, j) => b.setAttribute('aria-pressed', String(j === i)));
    badge.className = 'badge badge--' + s.status;
    badge.textContent = s.label;
    text.textContent = s.text;
    track.replaceChildren(
      ...STAGES.map((label, j) => node('li', { class: i === 3 || j < i ? 'done' : j === i ? 'now' : '' }, label))
    );
    for (let n = 1; n <= 3; n += 1) $('chip-' + n).classList.toggle('lit', n <= s.layers);
  }
  const stop = () => {
    if (timer) clearInterval(timer);
    timer = null;
  };
  const play = () => {
    if (reduceMotion || userChose || timer) return;
    timer = setInterval(() => show((current + 1) % STEPS.length), 4500);
  };
  buttons.forEach((b, i) =>
    b.addEventListener('click', () => {
      userChose = true; // once the visitor takes control, it stays put
      stop();
      show(i);
    })
  );
  const box = document.querySelector('.demo');
  box.addEventListener('pointerenter', stop);
  box.addEventListener('pointerleave', play);
  box.addEventListener('focusin', stop);
  box.addEventListener('focusout', play);
  show(0);
  play();
}

// ---- role tabs (arrow keys, Home and End work as people expect)
function roleTabs() {
  const tabs = [...document.querySelectorAll('.tab')];
  const select = (tab, focus) => {
    for (const t of tabs) {
      const on = t === tab;
      t.setAttribute('aria-selected', String(on));
      t.tabIndex = on ? 0 : -1;
      $(t.getAttribute('aria-controls')).hidden = !on;
    }
    if (focus) tab.focus();
  };
  tabs.forEach((t, i) => {
    t.addEventListener('click', () => select(t, false));
    t.addEventListener('keydown', (e) => {
      const to = { ArrowRight: (i + 1) % tabs.length, ArrowLeft: (i - 1 + tabs.length) % tabs.length, Home: 0, End: tabs.length - 1 }[e.key];
      if (to === undefined) return;
      e.preventDefault();
      select(tabs[to], true);
    });
  });
}

// ---- the institution's departments (public list, no personal data)
async function departments() {
  if (!slug) return;
  try {
    const res = await fetch('/api/t/' + slug + '/meta/departments', { credentials: 'omit' });
    if (!res.ok) return;
    const { data } = await res.json();
    const items = (data && data.items) || [];
    if (!items.length) return;
    const list = $('dept-list');
    for (const d of items) list.append(node('li', { class: 'chip', title: d.name }, d.code));
    $('dept-box').hidden = false;
  } catch (_e) {
    /* leave the strip without departments */
  }
}

// ---- live service status, from the same public check the hosting platform uses
async function status() {
  const pill = $('status-pill');
  const label = $('status-text');
  try {
    const res = await fetch('/readyz', { cache: 'no-store', credentials: 'omit' });
    await res.text(); // read the whole answer so the request is finished, not left open
    const ok = res.ok;
    pill.classList.add(ok ? 'ok' : 'down');
    label.textContent = ok ? 'All systems operational' : 'Some services are unavailable right now';
  } catch (_e) {
    pill.classList.add('down');
    label.textContent = 'Status unavailable';
  }
}

export function initLanding() {
  themeButton();
  revealOnScroll();
  heroTilt();
  demo();
  roleTabs();
  departments();
  status();
}
