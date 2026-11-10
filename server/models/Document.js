'use strict';

const mongoose = require('mongoose');
const tenantScope = require('./plugins/tenantScope');

// One stored file issued for a request. A request can have several. Replacing a document
// creates a new version and marks the old one REPLACED; revoking marks it REVOKED. Records are
// never deleted, so the history stays; the files of old versions are removed later by the
// cleanup script after the retention period.
const documentSchema = new mongoose.Schema(
  {
    requestId: { type: mongoose.Schema.Types.ObjectId, ref: 'Request', required: true },
    // Storage key: <tenantId>/<requestId>/<uuid>.<ext>. Never sent to clients.
    key: { type: String, required: true, select: false },
    fileType: { type: String, enum: ['pdf', 'png', 'jpg'], required: true },
    sizeBytes: { type: Number, required: true, min: 1 },
    // SHA-256 of the exact bytes stored. Part of the verification code; never sent to clients.
    sha256: { type: String, required: true, select: false, match: /^[0-9a-f]{64}$/ },
    status: { type: String, enum: ['ACTIVE', 'REPLACED', 'REVOKED'], default: 'ACTIVE', required: true },
    version: { type: Number, default: 1, min: 1 },
    supersedes: { type: mongoose.Schema.Types.ObjectId, ref: 'Document', default: null },
    uploadedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    replacedAt: { type: Date, default: null },
    revokedAt: { type: Date, default: null },
    revokedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    revokedReason: { type: String, maxlength: 500, default: null },
    // Set by the cleanup script once the stored file of a replaced/revoked document is gone.
    purgedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

documentSchema.plugin(tenantScope);
documentSchema.index({ tenantId: 1, requestId: 1, status: 1 });
documentSchema.index({ key: 1 }, { unique: true });

documentSchema.set('toJSON', {
  transform(_doc, ret) {
    delete ret.key;
    delete ret.sha256;
    delete ret.__v;
    return ret;
  },
});

module.exports = mongoose.model('Document', documentSchema);
