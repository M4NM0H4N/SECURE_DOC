'use strict';

const ROLES = Object.freeze({
  STUDENT: 'STUDENT',
  CLERK: 'CLERK',
  HOD: 'HOD',
  // Institution-wide approver (no department). Used for extra approval steps (S2).
  PRINCIPAL: 'PRINCIPAL',
  ADMIN: 'ADMIN',
  // Platform operator: tenantless, never reads document contents (S1).
  SUPER_ADMIN: 'SUPER_ADMIN',
});

// Roles an Admin may create through POST /api/admin/users (never ADMIN, never STUDENT)
const STAFF_ROLES = Object.freeze([ROLES.CLERK, ROLES.HOD, ROLES.PRINCIPAL]);

// Roles that may own an approval step in a workflow. Fulfilment is always a Clerk.
const WORKFLOW_STEP_ROLES = Object.freeze([ROLES.CLERK, ROLES.HOD, ROLES.PRINCIPAL]);
// Roles that belong to one department (their requests are scoped by it).
const DEPARTMENT_ROLES = Object.freeze([ROLES.STUDENT, ROLES.CLERK, ROLES.HOD]);

const REQUEST_STATUSES = Object.freeze({
  PENDING: 'PENDING',
  UNDER_REVIEW: 'UNDER_REVIEW',
  NEEDS_INFO: 'NEEDS_INFO',
  APPROVED: 'APPROVED',
  REJECTED: 'REJECTED',
  FULFILLED: 'FULFILLED',
});

// Seeded into every new institution (signup, migration, tests). After that they are the
// institution's own data and editable by its Admin (S2). Nothing else reads these lists.
const DEFAULT_DEPARTMENTS = Object.freeze([
  { code: 'CSE', name: 'Computer Science and Engineering' },
  { code: 'ME', name: 'Mechanical Engineering' },
  { code: 'CIVIL', name: 'Civil Engineering' },
  { code: 'ECE', name: 'Electronics and Communication Engineering' },
  { code: 'EEE', name: 'Electrical and Electronics Engineering' },
]);

const DEFAULT_DOCUMENT_TYPES = Object.freeze([
  'Bonafide Certificate',
  'Fee Receipt',
  'Transcript',
  'Transfer Certificate',
  'Character Certificate',
  'Other',
]);

// The MVP's fixed chain, now just the default definition: Clerk review, then HOD decision.
// After the last step the request is APPROVED and a Clerk uploads the document (FULFILLED).
const DEFAULT_WORKFLOW_STEPS = Object.freeze([
  { key: 'clerk-review', label: 'Clerk review', role: ROLES.CLERK, departmentScoped: true, canReject: false },
  { key: 'hod-decision', label: 'HOD decision', role: ROLES.HOD, departmentScoped: true, canReject: true },
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
  'REQUEST_INFO_REQUESTED',
  'REQUEST_RESUBMITTED',
  'DOCUMENT_UPLOADED',
  'REQUEST_FULFILLED',
  'DOCUMENT_DOWNLOADED',
  'TENANT_CREATED',
  'PLATFORM_LOGIN',
  'DEPARTMENT_CREATED',
  'DEPARTMENT_UPDATED',
  'DOCUMENT_TYPE_CREATED',
  'DOCUMENT_TYPE_UPDATED',
  'WORKFLOW_UPDATED',
  'INVITE_CREATED',
  'INVITE_RESENT',
  'INVITE_REVOKED',
  'INVITE_ACCEPTED',
  'PASSWORD_CHANGED',
  'PASSWORD_RESET',
  'PASSWORD_RESET_ISSUED',
  'EMAIL_VERIFIED',
  'ACCOUNT_LOCKED',
  'ACCOUNT_UNLOCKED',
  'SESSIONS_REVOKED',
  'MFA_ENABLED',
  'MFA_DISABLED',
  'DOCUMENT_ADDED',
  'DOCUMENT_REPLACED',
  'DOCUMENT_REVOKED',
  'DOCUMENT_REJECTED_INFECTED',
]);

// Account-security tuning (S3).
const SECURITY = Object.freeze({
  MAX_FAILED_LOGINS: 5,
  LOCKOUT_MS: 15 * 60 * 1000,
  INVITE_TTL_MS: 7 * 24 * 60 * 60 * 1000,
  RESET_TTL_MS: 60 * 60 * 1000,
  VERIFY_TTL_MS: 48 * 60 * 60 * 1000,
  MFA_CHALLENGE_TTL: '5m',
  BACKUP_CODES: 10,
  // Roles that may enrol in TOTP multi-factor authentication.
  MFA_ROLES: ['CLERK', 'HOD', 'PRINCIPAL', 'ADMIN'],
});

module.exports = {
  AUDIT_ACTIONS,
  SECURITY,
  ROLES,
  STAFF_ROLES,
  WORKFLOW_STEP_ROLES,
  DEPARTMENT_ROLES,
  REQUEST_STATUSES,
  DEFAULT_DEPARTMENTS,
  DEFAULT_DOCUMENT_TYPES,
  DEFAULT_WORKFLOW_STEPS,
};
