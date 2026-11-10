import { api, el, apiUrl } from './api.js';
import { formatDate } from './format.js';
import { requireUser, showAlert, hideAlert } from './layout.js';

const me = await requireUser(['ADMIN']);
if (me) init();

function init() {
  document.getElementById('content').classList.remove('hidden');
  document.getElementById('spec').href = apiUrl('/v1/openapi.json');
  const alertBox = document.getElementById('page-alert');
  const secretBox = document.getElementById('secret-box');
  const secretValue = document.getElementById('secret-value');
  const fail = (err) => showAlert(alertBox, err.errors?.map((x) => x.message).join(' ') || err.message);

  // Keys and signing secrets exist in readable form only once: here.
  function showSecret(note, value) {
    document.getElementById('secret-note').textContent = note;
    secretValue.value = value;
    secretBox.classList.remove('hidden');
    secretBox.scrollIntoView({ block: 'nearest' });
  }
  document.getElementById('secret-copy').addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(secretValue.value);
      showAlert(alertBox, 'Copied.', 'success');
    } catch (_e) {
      secretValue.select();
    }
  });
  const button = (text, fn, cls = 'btn btn--ghost btn--sm') => {
    const b = el('button', { class: cls, type: 'button', text });
    b.addEventListener('click', async () => {
      hideAlert(alertBox);
      b.disabled = true;
      try {
        await fn();
      } catch (err) {
        fail(err);
      } finally {
        b.disabled = false;
      }
    });
    return b;
  };

  // ---- API keys
  const keyRows = document.getElementById('key-rows');
  async function loadKeys() {
    const { items } = await api('/admin/api-keys');
    keyRows.replaceChildren(...items.map((k) => el('tr', {},
      el('td', { text: k.name }), el('td', { text: k.scopes.join(', ') }),
      el('td', {}, el('span', { class: `badge badge--${k.status === 'ACTIVE' ? 'active' : 'inactive'}`, text: k.status })),
      el('td', { text: k.lastUsedAt ? formatDate(k.lastUsedAt) : 'never' }),
      el('td', {}, k.status === 'ACTIVE' ? button('Revoke', async () => { await api(`/admin/api-keys/${k._id}`, { method: 'DELETE' }); await loadKeys(); }) : '')
    )));
  }
  document.getElementById('key-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    hideAlert(alertBox);
    const scopes = [];
    if (document.getElementById('scope-requests').checked) scopes.push('requests:read');
    if (document.getElementById('scope-analytics').checked) scopes.push('analytics:read');
    const days = document.getElementById('key-days').value;
    try {
      const { secret } = await api('/admin/api-keys', { method: 'POST', body: { name: document.getElementById('key-name').value, scopes, expiresInDays: days ? Number(days) : undefined } });
      e.target.reset();
      document.getElementById('scope-requests').checked = true;
      showSecret('API key created. Copy it now: it will not be shown again. Use it as: Authorization: Bearer <key>', secret);
      await loadKeys();
    } catch (err) {
      fail(err);
    }
  });

  // ---- webhooks
  const hookRows = document.getElementById('hook-rows');
  const evBox = document.getElementById('hook-events');
  const deliveries = document.getElementById('deliveries');
  async function loadHooks() {
    const { items, events, available } = await api('/admin/webhooks');
    if (!available) document.getElementById('hook-note').textContent = 'Webhooks are not switched on for this installation (the server has no WEBHOOK_ENCRYPTION_KEY).';
    if (!evBox.children.length) {
      for (const ev of events) evBox.append(el('label', { class: 'row' }, el('input', { type: 'checkbox', value: ev, checked: '' }), el('span', { text: ` ${ev}` })));
    }
    hookRows.replaceChildren(...items.map((h) => el('tr', {},
      el('td', { text: h.name }), el('td', { text: h.events.join(', ') }),
      el('td', {}, el('span', { class: `badge badge--${h.active ? 'active' : 'inactive'}`, text: h.active ? 'Active' : h.disabledReason || 'Off' })),
      el('td', {}, el('div', { class: 'actions' },
        button(h.active ? 'Switch off' : 'Switch on', async () => { await api(`/admin/webhooks/${h._id}`, { method: 'PATCH', body: { active: !h.active } }); await loadHooks(); }),
        button('Send test', async () => { await api(`/admin/webhooks/${h._id}/ping`, { method: 'POST' }); showAlert(alertBox, 'Test event queued. It is delivered within a few seconds.', 'success'); }),
        button('New secret', async () => { const r = await api(`/admin/webhooks/${h._id}/rotate-secret`, { method: 'POST' }); showSecret('New signing secret. The old one stopped working. Copy it now.', r.secret); }),
        button('History', async () => showDeliveries(h)),
        button('Delete', async () => { await api(`/admin/webhooks/${h._id}`, { method: 'DELETE' }); deliveries.classList.add('hidden'); await loadHooks(); })
      ))
    )));
  }
  async function showDeliveries(h) {
    const { items } = await api(`/admin/webhooks/${h._id}/deliveries?limit=20`);
    deliveries.classList.remove('hidden');
    deliveries.replaceChildren(el('h3', { text: `Recent deliveries: ${h.name}` }), items.length ? el('ul', {}, ...items.map((d) => el('li', { text: `${formatDate(d.createdAt)} · ${d.event} · ${d.status} · tries ${d.attempts}${d.lastError ? ` · ${d.lastError}` : ''}` }))) : el('p', { class: 'muted', text: 'Nothing sent yet.' }));
  }
  document.getElementById('hook-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    hideAlert(alertBox);
    const events = [...evBox.querySelectorAll('input:checked')].map((i) => i.value);
    try {
      const { secret } = await api('/admin/webhooks', { method: 'POST', body: { name: document.getElementById('hook-name').value, url: document.getElementById('hook-url').value, events } });
      e.target.reset();
      for (const i of evBox.querySelectorAll('input')) i.checked = true;
      showSecret('Webhook created. This is its signing secret: copy it now, it will not be shown again.', secret);
      await loadHooks();
    } catch (err) {
      fail(err);
    }
  });

  Promise.all([loadKeys(), loadHooks()]).catch(fail);
}
