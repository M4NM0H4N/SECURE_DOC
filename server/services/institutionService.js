'use strict';

const Department = require('../models/Department');
const DocumentType = require('../models/DocumentType');
const WorkflowDefinition = require('../models/WorkflowDefinition');
const { DEFAULT_DEPARTMENTS, DEFAULT_DOCUMENT_TYPES, DEFAULT_WORKFLOW_STEPS } = require('../config/constants');

// Gives the CURRENT tenant context its starting configuration: the MVP's five departments,
// six document types and the Clerk -> HOD chain. Idempotent per collection, so running it
// twice (or on an institution that already customised something) changes nothing.
// Must be called inside runAsTenant.
async function seedDefaults({ session } = {}) {
  const opt = session ? { session, ordered: true } : {};
  const created = { departments: 0, documentTypes: 0, workflow: 0 };
  if (!(await Department.exists({}))) {
    await Department.create(DEFAULT_DEPARTMENTS.map((d) => ({ ...d })), opt);
    created.departments = DEFAULT_DEPARTMENTS.length;
  }
  if (!(await DocumentType.exists({}))) {
    await DocumentType.create(DEFAULT_DOCUMENT_TYPES.map((name) => ({ name })), opt);
    created.documentTypes = DEFAULT_DOCUMENT_TYPES.length;
  }
  if (!(await WorkflowDefinition.exists({}))) {
    await WorkflowDefinition.create([{ version: 1, steps: DEFAULT_WORKFLOW_STEPS.map((s) => ({ ...s })) }], opt);
    created.workflow = 1;
  }
  return created;
}

module.exports = { seedDefaults };
