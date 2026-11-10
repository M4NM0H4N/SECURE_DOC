'use strict';

const mongoose = require('mongoose');
const tenantScope = require('./plugins/tenantScope');

// One event for one webhook, delivered by the worker with retries. Written in the same
// transaction as the event that causes it (exactly once), like notifications.
const deliverySchema = new mongoose.Schema(
  {
    webhookId: { type: mongoose.Schema.Types.ObjectId, ref: 'Webhook', required: true, index: true },
    event: { type: String, required: true, maxlength: 40 },
    payload: { type: mongoose.Schema.Types.Mixed, required: true },
    dedupeKey: { type: String, required: true },
    status: { type: String, enum: ['PENDING', 'SENT', 'FAILED'], default: 'PENDING', required: true },
    attempts: { type: Number, default: 0 },
    notBefore: { type: Date, default: Date.now },
    lockedAt: { type: Date, default: null },
    lastStatus: { type: Number, default: null },
    lastError: { type: String, default: null, maxlength: 200 },
    sentAt: { type: Date, default: null },
  },
  { timestamps: true }
);

deliverySchema.plugin(tenantScope);
deliverySchema.index({ dedupeKey: 1 }, { unique: true });
deliverySchema.index({ status: 1, notBefore: 1 });
deliverySchema.index({ createdAt: 1 }, { expireAfterSeconds: 90 * 24 * 60 * 60 });

deliverySchema.set('toJSON', {
  transform(_doc, ret) {
    delete ret.__v;
    delete ret.dedupeKey;
    delete ret.lockedAt;
    return ret;
  },
});

module.exports = mongoose.model('WebhookDelivery', deliverySchema);
