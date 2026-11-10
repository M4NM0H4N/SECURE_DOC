'use strict';

const mongoose = require('mongoose');
const { WORKFLOW_STEP_ROLES } = require('../config/constants');
const tenantScope = require('./plugins/tenantScope');

const stepSchema = new mongoose.Schema(
  {
    key: { type: String, required: true },
    label: { type: String, required: true, trim: true, minlength: 2, maxlength: 60 },
    role: { type: String, enum: WORKFLOW_STEP_ROLES, required: true },
    // true: only staff of the request's own department may act (Clerk, HOD).
    // false: institution-wide approver (Principal).
    departmentScoped: { type: Boolean, required: true },
    canReject: { type: Boolean, default: false },
    // SLA (S5): hours the step may take, and who is told when it is overdue (default: the step's own role).
    slaHours: { type: Number, default: null, min: 1, max: 720 },
    escalateTo: { type: String, enum: [...WORKFLOW_STEP_ROLES, null], default: null },
  },
  { _id: false }
);

// Definitions are immutable. Editing the chain creates a new version; each request is
// pinned to the version it started with, so a change never reroutes work in progress.
// The current definition of an institution is its highest version.
const workflowSchema = new mongoose.Schema(
  {
    version: { type: Number, required: true, min: 1 },
    steps: { type: [stepSchema], validate: [(v) => v.length >= 1 && v.length <= 6, 'A workflow has 1-6 steps'] },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  },
  { timestamps: true }
);

workflowSchema.plugin(tenantScope);
workflowSchema.index({ tenantId: 1, version: 1 }, { unique: true });

module.exports = mongoose.model('WorkflowDefinition', workflowSchema);
