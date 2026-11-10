'use strict';

const mongoose = require('mongoose');
const { AUDIT_ACTIONS } = require('../config/constants');
const tenantScope = require('./plugins/tenantScope');

// Application-level append-only audit trail. There is no update or delete API,
// and the hooks below make the Mongoose model refuse them too. This is NOT
// absolute immutability: anyone with direct database access can still alter it.
const auditLogSchema = new mongoose.Schema(
  {
    actorId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    action: { type: String, enum: AUDIT_ACTIONS, required: true, index: true },
    requestId: { type: mongoose.Schema.Types.ObjectId, ref: 'Request', default: null, index: true },
    details: { type: mongoose.Schema.Types.Mixed, default: {} },
    timestamp: { type: Date, default: Date.now, index: true },
    // Hash chain (S7): position in the institution's chain, the previous entry's hash and this one's.
    seq: { type: Number, default: null },
    prevHash: { type: String, default: null },
    hash: { type: String, default: null },
  },
  { versionKey: false }
);

// tenantId is null only for platform events (SUPER_ADMIN login); tenant admins never see those.
auditLogSchema.plugin(tenantScope, { required: false });
auditLogSchema.index({ tenantId: 1, timestamp: -1 });
auditLogSchema.index({ tenantId: 1, seq: 1 }, { unique: true, partialFilterExpression: { seq: { $type: 'number' } } });

const BLOCKED = [
  'updateOne',
  'updateMany',
  'findOneAndUpdate',
  'findOneAndReplace',
  'replaceOne',
  'deleteOne',
  'deleteMany',
  'findOneAndDelete',
];
for (const op of BLOCKED) {
  auditLogSchema.pre(op, function blockMutation() {
    throw new Error('Audit records are append-only');
  });
}
auditLogSchema.pre('save', function blockResave() {
  if (!this.isNew) throw new Error('Audit records are append-only');
});

module.exports = mongoose.model('AuditLog', auditLogSchema);
