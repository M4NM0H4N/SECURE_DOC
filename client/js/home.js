import { api, ROLE_HOME, tpath } from './api.js';

api('/auth/me')
  .then(({ user }) => location.replace(ROLE_HOME[user.role]))
  .catch(() => location.replace(tpath('/login.html')));
