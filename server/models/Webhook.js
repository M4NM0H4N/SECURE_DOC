'use strict';

const mongoose = require('mongoose');
const tenantScope = require('./plugins/tenantScope');

const WEBHOOK_EVENTS = Object.freeze(['request.submitted', 'request.status_changed', 'document.issued', 'ping']);

// An outgoing webhook: where to send, which events, and a signing secret (stored encrypted, shown
// once). Payloads carry ids, statuses and times only, never names, purposes or files.
const webhookSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true, minlength: 2, maxlength: 60 },
    url: { type: String, required: true, maxlength: 500 },
    events: { type: [{ type: String, enum: WEBHOOK_EVENTS }], validate: [(v) => v.length >= 1, 'At least one event'] },
    secretEnc: { type: String, required: true, select: false },
    active: { type: Boolean, default: true },
    consecutiveFailures: { type: Number, default: 0 },
    disabledReason: { type: String, default: null, maxlength: 100 },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  },
  { timestamps: true }
);

webhookSchema.plugin(tenantScope);

webhookSchema.set('toJSON', {
  transform(_doc, ret) {
    delete ret.secretEnc;
    delete ret.__v;
    return ret;
  },
});

module.exports = mongoose.model('Webhook', webhookSchema);
module.exports.WEBHOOK_EVENTS = WEBHOOK_EVENTS;
