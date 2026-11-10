import { api, el, ROLE_HOME, apiUrl } from './api.js';
import { requireUser, showAlert, hideAlert } from './layout.js';
import { STATUS_LABELS } from './format.js';

const me = await requireUser(['ADMIN', 'PRINCIPAL']);
if (me) init();

function init() {
  document.getElementById('content').classList.remove('hidden');
  document.getElementById('back').href = ROLE_HOME[me.role];
  const alertBox = document.getElementById('page-alert');
  const from = document.getElementById('from');
  const to = document.getElementById('to');
  const csv = document.getElementById('csv');

  // A horizontal bar per row; the width is set through CSSOM (allowed by our CSP, unlike style attributes).
  function bars(host, entries) {
    host.replaceChildren();
    const max = Math.max(1, ...entries.map(([, n]) => n));
    if (!entries.length) host.append(el('p', { class: 'muted', text: 'No data for this period.' }));
    for (const [label, n] of entries) {
      const fill = el('div', { class: 'bar-fill' });
      fill.style.width = `${Math.max(2, Math.round((n / max) * 100))}%`;
      fill.style.height = '10px';
      fill.style.background = 'var(--primary)';
      fill.style.borderRadius = '5px';
      host.append(el('div', { class: 'stack' }, el('div', { class: 'req-head' }, el('span', { text: label }), el('strong', { text: String(n) })), fill));
    }
  }
  const card = (label, value, hint) => el('div', { class: 'stack' }, el('span', { class: 'muted', text: label }), el('strong', { text: String(value) }), hint ? el('span', { class: 'hint', text: hint }) : '');
  const hrs = (h) => (h === null ? 'n/a' : `${h} h`);

  async function load() {
    hideAlert(alertBox);
    const p = new URLSearchParams();
    if (from.value) p.set('from', from.value);
    if (to.value) p.set('to', to.value);
    csv.href = apiUrl(`/analytics/summary.csv?${p}`);
    try {
      const s = await api(`/analytics/summary?${p}`);
      document.getElementById('period-text').textContent = `Requests submitted ${from.value || 'since the start'} to ${to.value || 'today'}.`;
      document.getElementById('cards').replaceChildren(
        el('div', { class: 'form-row form-row--2' },
          card('Requests submitted', s.total),
          card('Still open', s.openRequests),
          card('Average turnaround', hrs(s.turnaround.averageHours), `median ${hrs(s.turnaround.medianHours)}, 90% within ${hrs(s.turnaround.p90Hours)} (${s.turnaround.fulfilled} fulfilled)`),
          card('Rejection rate', s.rejection.rate === null ? 'n/a' : `${Math.round(s.rejection.rate * 1000) / 10}%`, `${s.rejection.rejected} of ${s.rejection.decided} decided`),
          card('Deadline escalations', s.slaEscalations)
        )
      );
      bars(document.getElementById('backlog'), s.backlog.map((b) => [b.step, b.count]));
      bars(document.getElementById('months'), s.byMonth.map((m) => [m.month, m.count]));
      bars(document.getElementById('depts'), Object.entries(s.byDepartment));
      bars(document.getElementById('types'), Object.entries(s.byDocumentType));
      bars(document.getElementById('statuses'), Object.entries(s.byStatus).map(([k, v]) => [STATUS_LABELS[k] || k, v]));
    } catch (err) {
      showAlert(alertBox, err.errors?.map((x) => x.message).join(' ') || err.message);
    }
  }
  document.getElementById('period').addEventListener('submit', (e) => {
    e.preventDefault();
    load();
  });
  document.getElementById('print').addEventListener('click', () => window.print());
  load();
}
