'use strict';

const ROLES = Object.freeze({
  STUDENT: 'STUDENT',
  CLERK: 'CLERK',
  HOD: 'HOD',
  ADMIN: 'ADMIN',
  // Platform operator: tenantless, never reads document contents (S1).
  SUPER_ADMIN: 'SUPER_ADMIN',
});

// Roles an Admin may create through POST /api/admin/users (never ADMIN, never STUDENT)
const STAFF_ROLES = Object.freeze([ROLES.CLERK, ROLES.HOD]);

const DEPARTMENTS = Object.freeze(['CSE', 'ME', 'CIVIL', 'ECE', 'EEE']);

const REQUEST_STATUSES = Object.freeze({
  PENDING: 'PENDING',
  UNDER_REVIEW: 'UNDER_REVIEW',
  APPROVED: 'APPROVED',
  REJECTED: 'REJECTED',
  FULFILLED: 'FULFILLED',
});

const DOCUMENT_TYPES = Object.freeze([
  'Bonafide Certificate',
  'Fee Receipt',
  'Transcript',
  'Transfer Certificate',
  'Character Certificate',
  'Other',
]);

// Allowed state transitions: from -> { to, role }
const TRANSITIONS = Object.freeze([
  { from: 'PENDING', to: 'UNDER_REVIEW', role: ROLES.CLERK },
  { from: 'UNDER_REVIEW', to: 'APPROVED', role: ROLES.HOD },
  { from: 'UNDER_REVIEW', to: 'REJECTED', role: ROLES.HOD },
  { from: 'APPROVED', to: 'FULFILLED', role: ROLES.CLERK },
]);

const AUDIT_ACTIONS = Object.freeze([
  'USER_REGISTERED',
  'USER_LOGIN',
  'USER_CREATED_BY_ADMIN',
  'USER_ACTIVATED',
  'USER_DEACTIVATED',
  'REQUEST_SUBMITTED',
  'REQUEST_REVIEWED',
  'REQUEST_APPROVED',
  'REQUEST_REJECTED',
  'DOCUMENT_UPLOADED',
  'REQUEST_FULFILLED',
  'DOCUMENT_DOWNLOADED',
  'TENANT_CREATED',
  'PLATFORM_LOGIN',
]);

module.exports = {
  AUDIT_ACTIONS,
  ROLES,
  STAFF_ROLES,
  DEPARTMENTS,
  REQUEST_STATUSES,
  DOCUMENT_TYPES,
  TRANSITIONS,
};
