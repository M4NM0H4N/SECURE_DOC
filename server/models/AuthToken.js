'use strict';

const mongoose = require('mongoose');
const tenantScope = require('./plugins/tenantScope');

// One-time tokens for password reset and e-mail verification. Hash only; single use; expiring.
const authTokenSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    type: { type: String, enum: ['RESET', 'VERIFY_EMAIL'], required: true },
    tokenHash: { type: String, required: true },
    expiresAt: { type: Date, required: true },
    usedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

authTokenSchema.plugin(tenantScope);
authTokenSchema.index({ tokenHash: 1 }, { unique: true });
// Housekeeping: expired tokens are removed a week after they expire.
authTokenSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 7 * 24 * 60 * 60 });

module.exports = mongoose.model('AuthToken', authTokenSchema);
