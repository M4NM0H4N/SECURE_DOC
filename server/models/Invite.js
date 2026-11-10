'use strict';

const mongoose = require('mongoose');
const { STAFF_ROLES } = require('../config/constants');
const tenantScope = require('./plugins/tenantScope');

// A staff invitation. Only the SHA-256 hash of the token is stored, so a database leak does
// not hand out working links. Single use, expires, can be revoked.
const inviteSchema = new mongoose.Schema(
  {
    email: { type: String, required: true, lowercase: true, trim: true, maxlength: 254 },
    name: { type: String, trim: true, maxlength: 100, default: null },
    role: { type: String, enum: STAFF_ROLES, required: true },
    department: { type: String, default: null, uppercase: true, trim: true, maxlength: 10 },
    tokenHash: { type: String, required: true, select: false },
    expiresAt: { type: Date, required: true },
    usedAt: { type: Date, default: null },
    revokedAt: { type: Date, default: null },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  },
  { timestamps: true }
);

inviteSchema.plugin(tenantScope);
inviteSchema.index({ tokenHash: 1 }, { unique: true });
// Retention: an invitation record is removed 90 days after it expired (used or not).
inviteSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 90 * 24 * 60 * 60 });
inviteSchema.index({ tenantId: 1, email: 1 });

inviteSchema.set('toJSON', {
  transform(_doc, ret) {
    delete ret.tokenHash;
    delete ret.__v;
    const now = new Date();
    ret.status = ret.usedAt ? 'ACCEPTED' : ret.revokedAt ? 'REVOKED' : new Date(ret.expiresAt) <= now ? 'EXPIRED' : 'PENDING';
    return ret;
  },
});

module.exports = mongoose.model('Invite', inviteSchema);
