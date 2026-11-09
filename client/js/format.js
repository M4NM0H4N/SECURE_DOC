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
