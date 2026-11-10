// Institution branding: colour, logo, name. Public data (the sign-in page needs it too). It only ever
// sets CSS custom properties and an <img>, and a failure leaves the default look untouched.
const m = location.pathname.match(/^\/t\/([a-z0-9-]+)(?:\/|$)/);

function darken(hex, f) {
  const c = [1, 3, 5].map((i) => Math.round(parseInt(hex.slice(i, i + 2), 16) * f));
  return '#' + c.map((v) => v.toString(16).padStart(2, '0')).join('');
}

// One request per page; applyBranding() can be called again after more of the page has been built
// (the top bar is created after this module loads) and then only repeats the cheap DOM part.
let pending = null;
const fetchBranding = () => {
  if (!pending) {
    pending = fetch('/api/t/' + m[1] + '/branding', { credentials: 'omit' }).then((r) => (r.ok ? r.json().then((j) => j.data) : null));
  }
  return pending;
};

export async function applyBranding() {
  if (!m) return;
  try {
    const b = await fetchBranding();
    if (!b) return;
    // The colour was checked on the server to be readable on white, so it is used in light mode only;
    // dark mode keeps its own tuned palette.
    if (b.color && !window.matchMedia('(prefers-color-scheme: dark)').matches) {
      const root = document.documentElement.style;
      root.setProperty('--primary', b.color);
      root.setProperty('--primary-hover', darken(b.color, 0.85));
      root.setProperty('--primary-contrast', '#ffffff');
    }
    const logoUrl = b.hasLogo ? '/api/t/' + m[1] + '/branding/logo?v=' + b.logoVersion : null;
    for (const brand of document.querySelectorAll('.brand')) {
      if (logoUrl && !brand.querySelector('img')) {
        const img = document.createElement('img');
        img.src = logoUrl;
        img.alt = '';
        img.height = 36;
        img.style.maxWidth = '120px';
        img.style.objectFit = 'contain';
        const svg = brand.querySelector('svg');
        if (svg) svg.replaceWith(img);
        else brand.prepend(img);
      }
      const label = brand.querySelector('span');
      if (label && label.textContent === 'DocFlow' && b.name) label.textContent = b.name;
    }
    const tag = document.getElementById('brand-tagline');
    if (tag && b.tagline) tag.textContent = b.tagline;
    if (b.name && /DocFlow$/.test(document.title)) document.title = document.title.replace(/DocFlow$/, b.name);
  } catch (_e) {
    /* default look */
  }
}
