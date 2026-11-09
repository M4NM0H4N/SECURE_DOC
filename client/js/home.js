import { api, ROLE_HOME } from './api.js';

api('/auth/me')
  .then(({ user }) => location.replace(ROLE_HOME[user.role]))
  .catch(() => location.replace('/login.html'));
