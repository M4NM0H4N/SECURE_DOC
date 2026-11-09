'use strict';

const mongoose = require('mongoose');
const { DEPARTMENTS, DOCUMENT_TYPES, REQUEST_STATUSES } = require('../config/constants');
const tenantScope = require('./plugins/tenantScope');

const historySchema = new mongoose.Schema(
  {
    from: { type: String, enum: [...Object.values(REQUEST_STATUSES), null], default: null },
    to: { type: String, enum: Object.values(REQUEST_STATUSES), required: true },
    by: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    at: { type: Date, default: Date.now },
    note: { type: String, maxlength: 500 },
  },
  { _id: false }
);

const requestSchema = new mongoose.Schema(
  {
    studentId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    // Copied from the student's profile at creation; never taken from input.
    department: { type: String, enum: DEPARTMENTS, required: true },
    documentType: { type: String, enum: DOCUMENT_TYPES, required: true },
    purpose: { type: String, required: true, trim: true, minlength: 10, maxlength: 500 },
    status: {
      type: String,
      enum: Object.values(REQUEST_STATUSES),
      default: REQUEST_STATUSES.PENDING,
      required: true,
    },
    reviewedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    decidedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    rejectionReason: { type: String, maxlength: 500, default: null },
    // Random server-side filename only (Phase 4). Never exposed in API output.
    documentPath: { type: String, default: null, select: false },
    statusHistory: { type: [historySchema], default: [] },
  },
  { timestamps: true }
);

requestSchema.plugin(tenantScope);
requestSchema.index({ tenantId: 1, department: 1, status: 1, createdAt: -1 });
requestSchema.index({ tenantId: 1, studentId: 1, createdAt: -1 });

requestSchema.set('toJSON', {
  transform(_doc, ret) {
    delete ret.documentPath;
    delete ret.__v;
    // Tell clients whether a document exists without leaking its storage path.
    return ret;
  },
});

module.exports = mongoose.model('Request', requestSchema);
