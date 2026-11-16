import { el } from './api.js';

export const STATUS_LABELS = {
  PENDING: 'Pending',
  UNDER_REVIEW: 'Under review',
  NEEDS_INFO: 'Needs information',
  APPROVED: 'Approved',
  REJECTED: 'Rejected',
  FULFILLED: 'Fulfilled',
};

export function statusBadge(status) {
  return el('span', { class: `badge badge--${status.toLowerCase()}`, text: STATUS_LABELS[status] || status });
}

export function formatDate(iso) {
  return new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

// Progress track shown on request cards and the detail page. Generic stages: the exact approval chain is
// configured per institution, but every request moves Submitted -> Review -> Approved -> Issued (or stops at Rejected).
const STAGES = ['Submitted', 'Review', 'Approved', 'Issued'];
export function progress(status) {
  const at = { PENDING: 0, NEEDS_INFO: 0, UNDER_REVIEW: 1, APPROVED: 2, FULFILLED: 3, REJECTED: 1 }[status] ?? 0;
  const ol = el('ol', { class: 'track', 'aria-label': 'Progress' });
  STAGES.forEach((label, i) => {
    let cls = '';
    if (status === 'FULFILLED' || i < at) cls = 'done';
    else if (i === at) cls = status === 'REJECTED' ? 'stop' : 'now';
    ol.append(el('li', { class: cls, text: status === 'REJECTED' && i === at ? 'Rejected' : label }));
  });
  return ol;
}
