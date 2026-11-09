import { api, el } from './api.js';
import { requireUser, showAlert, hideAlert } from './layout.js';

// Admin-only configuration of the institution: approval chain, departments, document types.
// The server validates everything again; this page only makes the lists easy to edit.
const me = await requireUser(['ADMIN']);
if (me) init();

const ROLE_LABELS = { CLERK: 'Clerk', HOD: 'HOD', PRINCIPAL: 'Principal' };

function init() {
  document.getElementById('content').classList.remove('hidden');
  const alertBox = document.getElementById('page-alert');
  const say = (msg, type = 'error') => {
    showAlert(alertBox, msg, type);
    alertBox.scrollIntoView({ block: 'nearest' });
  };
  const fail = (err) => say(err.errors?.map((x) => x.message).join(' ') || err.message);

  // ---- approval chain -----------------------------------------------------------------
  const stepsBox = document.getElementById('steps');
  const info = document.getElementById('workflow-info');
  let steps = [];

  function renderSteps() {
    stepsBox.replaceChildren();
    steps.forEach((s, i) => {
      const label = el('input', { class: 'input', maxlength: '60', value: s.label, 'aria-label': `Step ${i + 1} name` });
      label.addEventListener('input', () => (s.label = label.value));
      const role = el('select', { class: 'select', 'aria-label': `Step ${i + 1} role` });
      for (const [value, text] of Object.entries(ROLE_LABELS)) role.append(el('option', { value, text }));
      role.value = s.role;
      role.addEventListener('change', () => (s.role = role.value));
      const rej = el('input', { type: 'checkbox', id: `rej-${i}` });
      rej.checked = Boolean(s.canReject);
      rej.addEventListener('change', () => (s.canReject = rej.checked));
      const btn = (text, fn, disabled) => {
        const b = el('button', { class: 'btn btn--ghost btn--sm', type: 'button', text });
        b.disabled = disabled;
        b.addEventListener('click', fn);
        return b;
      };
      stepsBox.append(
        el(
          'div',
          { class: 'stack' },
          el('strong', { text: `Step ${i + 1}` }),
          el('div', { class: 'form-row form-row--2' }, label, role),
          el('label', { for: `rej-${i}` }, rej, el('span', { text: ' May reject requests at this step' })),
          el(
            'div',
            { class: 'actions' },
            btn('Move up', () => move(i, -1), i === 0),
            btn('Move down', () => move(i, 1), i === steps.length - 1),
            btn('Remove', () => remove(i), steps.length === 1)
          )
        )
      );
    });
    document.getElementById('add-step').disabled = steps.length >= 6;
  }
  function move(i, d) {
    [steps[i], steps[i + d]] = [steps[i + d], steps[i]];
    renderSteps();
  }
  function remove(i) {
    steps.splice(i, 1);
    renderSteps();
  }
  document.getElementById('add-step').addEventListener('click', () => {
    steps.push({ label: '', role: 'CLERK', canReject: false });
    renderSteps();
  });

  async function loadWorkflow() {
    const { workflow } = await api('/admin/workflow');
    steps = workflow.steps.map((s) => ({ label: s.label, role: s.role, canReject: s.canReject }));
    const bits = [`Version ${workflow.version}.`];
    if (workflow.requestsOnOlderVersions) bits.push(`${workflow.requestsOnOlderVersions} request(s) are still finishing under an earlier chain.`);
    if (workflow.rolesWithoutActiveStaff.length) {
      bits.push(`No active staff yet for: ${workflow.rolesWithoutActiveStaff.map((r) => ROLE_LABELS[r] || r).join(', ')}. Requests would wait for them.`);
    }
    info.textContent = bits.join(' ');
    renderSteps();
  }
  document.getElementById('save-workflow').addEventListener('click', async (e) => {
    hideAlert(alertBox);
    e.target.disabled = true;
    try {
      const { workflow } = await api('/admin/workflow', { method: 'PUT', body: { steps } });
      say(`Saved as version ${workflow.version}. New requests use it.`, 'success');
      await loadWorkflow();
    } catch (err) {
      fail(err);
    } finally {
      e.target.disabled = false;
    }
  });

  // ---- departments and document types -------------------------------------------------
  function badge(active) {
    return el('span', { class: `badge badge--${active ? 'active' : 'inactive'}`, text: active ? 'Active' : 'Inactive' });
  }
  function toggleBtn(item, path, reload) {
    const b = el('button', { class: 'btn btn--ghost btn--sm', type: 'button', text: item.isActive ? 'Deactivate' : 'Activate' });
    b.addEventListener('click', async () => {
      b.disabled = true;
      try {
        await api(path, { method: 'PATCH', body: { isActive: !item.isActive } });
        await reload();
      } catch (err) {
        fail(err);
        b.disabled = false;
      }
    });
    return b;
  }
  function renameBtn(item, path, reload) {
    const b = el('button', { class: 'btn btn--ghost btn--sm', type: 'button', text: 'Rename' });
    b.addEventListener('click', () => {
      const input = el('input', { class: 'input', value: item.name, maxlength: '100', 'aria-label': 'New name' });
      const save = el('button', { class: 'btn btn--sm', type: 'button', text: 'Save' });
      b.replaceWith(input, save);
      save.addEventListener('click', async () => {
        save.disabled = true;
        try {
          await api(path, { method: 'PATCH', body: { name: input.value } });
          await reload();
        } catch (err) {
          fail(err);
          save.disabled = false;
        }
      });
    });
    return b;
  }

  const deptRows = document.getElementById('dept-rows');
  async function loadDepartments() {
    const { items } = await api('/admin/departments');
    deptRows.replaceChildren(
      ...items.map((d) =>
        el(
          'tr',
          {},
          el('td', { text: d.code }),
          el('td', { text: d.name }),
          el('td', {}, badge(d.isActive)),
          el('td', {}, el('div', { class: 'actions' }, renameBtn(d, `/admin/departments/${d._id}`, loadDepartments), toggleBtn(d, `/admin/departments/${d._id}`, loadDepartments)))
        )
      )
    );
  }
  document.getElementById('dept-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    hideAlert(alertBox);
    try {
      await api('/admin/departments', { method: 'POST', body: { code: e.target['dept-code'].value, name: e.target['dept-name'].value } });
      e.target.reset();
      await loadDepartments();
    } catch (err) {
      fail(err);
    }
  });

  const typeRows = document.getElementById('type-rows');
  async function loadTypes() {
    const { items } = await api('/admin/document-types');
    typeRows.replaceChildren(
      ...items.map((t) =>
        el(
          'tr',
          {},
          el('td', { text: t.name }),
          el('td', {}, badge(t.isActive)),
          el('td', {}, el('div', { class: 'actions' }, renameBtn(t, `/admin/document-types/${t._id}`, loadTypes), toggleBtn(t, `/admin/document-types/${t._id}`, loadTypes)))
        )
      )
    );
  }
  document.getElementById('type-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    hideAlert(alertBox);
    try {
      await api('/admin/document-types', { method: 'POST', body: { name: e.target['type-name'].value } });
      e.target.reset();
      await loadTypes();
    } catch (err) {
      fail(err);
    }
  });

  Promise.all([loadWorkflow(), loadDepartments(), loadTypes()]).catch(fail);
}
