import { api, ROLE_HOME } from './api.js';
import { applyBranding } from './branding.js';

// Signed-in visitors go straight to their own dashboard; everyone else sees the landing page.
api('/auth/me')
  .then(({ user }) => location.replace(ROLE_HOME[user.role]))
  .catch(() => {
    document.getElementById('redirecting').classList.add('hidden');
    document.getElementById('landing').classList.remove('hidden');
    applyBranding(); // the institution's name, tagline and logo
  });
