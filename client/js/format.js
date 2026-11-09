import { el } from './api.js';

// Mirror of server/config/constants.js (the server remains the source of truth).
export const DOCUMENT_TYPES = [
  'Bonafide Certificate',
  'Fee Receipt',
  'Transcript',
  'Transfer Certificate',
  'Character Certificate',
  'Other',
];

export const STATUS_LABELS = {
  PENDING: 'Pending',
  UNDER_REVIEW: 'Under review',
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
