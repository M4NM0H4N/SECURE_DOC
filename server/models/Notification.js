'use strict';

const mongoose = require('mongoose');
const tenantScope = require('./plugins/tenantScope');

// One row per message to one person on one channel.
//   IN_APP  the bell and list in the app. Created already SENT.
//   EMAIL   an outbox entry: PENDING until the worker delivers it (or gives up: FAILED).
// Ordinary notifications are written in the SAME transaction as the event that causes them, so
// each event produces them exactly once (or not at all if it rolls back). `dedupeKey` makes the
// write idempotent. No secret ever lives here: invite, reset and verification links are never
// stored (their delivery is recorded without the link, type SECURITY_*).
const notificationSchema = new mongoose.Schema(
  {
    // null for mail to someone who has no account yet (an invitee).
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null, index: true },
    channel: { type: String, enum: ['IN_APP', 'EMAIL'], required: true },
    type: { type: String, required: true, maxlength: 40 },
    // What the person sees in the app (short, no secrets).
    title: { type: String, maxlength: 140, default: '' },
    body: { type: String, maxlength: 300, default: '' },
    // Where the link goes (an in-app page, never a token) and what the e-mail template needs.
    requestId: { type: mongoose.Schema.Types.ObjectId, ref: 'Request', default: null },
    template: { type: String, maxlength: 40, default: null },
    data: { type: mongoose.Schema.Types.Mixed, default: {} },
    dedupeKey: { type: String, required: true },
    status: { type: String, enum: ['PENDING', 'SENT', 'FAILED', 'CANCELLED'], default: 'PENDING', required: true },
    attempts: { type: Number, default: 0 },
    notBefore: { type: Date, default: Date.now },
    lockedAt: { type: Date, default: null },
    lastError: { type: String, maxlength: 200, default: null },
    sentAt: { type: Date, default: null },
    readAt: { type: Date, default: null },
  },
  { timestamps: true }
);

notificationSchema.plugin(tenantScope);
notificationSchema.index({ dedupeKey: 1 }, { unique: true });
notificationSchema.index({ tenantId: 1, userId: 1, channel: 1, createdAt: -1 });
notificationSchema.index({ status: 1, notBefore: 1 });
// Housekeeping: rows disappear a year after they were created.
notificationSchema.index({ createdAt: 1 }, { expireAfterSeconds: 365 * 24 * 60 * 60 });

notificationSchema.set('toJSON', {
  transform(_doc, ret) {
    delete ret.__v;
    delete ret.dedupeKey;
    delete ret.lockedAt;
    return ret;
  },
});

module.exports = mongoose.model('Notification', notificationSchema);
