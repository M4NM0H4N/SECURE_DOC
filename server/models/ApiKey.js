'use strict';

const mongoose = require('mongoose');
const tenantScope = require('./plugins/tenantScope');

// A read-only key for an institution's integrations. The full key (dfk_<prefix>_<secret>) is shown
// ONCE; only the prefix (to find the key) and a SHA-256 of the secret are stored. Scopes limit what
// it may read; no scope grants writes or document contents.
const API_SCOPES = Object.freeze(['requests:read', 'analytics:read']);

const apiKeySchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true, minlength: 2, maxlength: 60 },
    prefix: { type: String, required: true, match: /^[a-z0-9]{8}$/ },
    secretHash: { type: String, required: true, select: false },
    scopes: { type: [{ type: String, enum: API_SCOPES }], validate: [(v) => v.length >= 1, 'At least one scope'] },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    expiresAt: { type: Date, default: null },
    revokedAt: { type: Date, default: null },
    lastUsedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

apiKeySchema.plugin(tenantScope);
apiKeySchema.index({ prefix: 1 }, { unique: true });

apiKeySchema.set('toJSON', {
  transform(_doc, ret) {
    delete ret.secretHash;
    delete ret.__v;
    ret.status = ret.revokedAt ? 'REVOKED' : ret.expiresAt && new Date(ret.expiresAt) <= new Date() ? 'EXPIRED' : 'ACTIVE';
    return ret;
  },
});

module.exports = mongoose.model('ApiKey', apiKeySchema);
module.exports.API_SCOPES = API_SCOPES;
