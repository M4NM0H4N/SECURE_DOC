'use strict';

const mongoose = require('mongoose');

// A platform-level record (not tenant data) that a background process is alive. The worker writes it
// every pass; /readyz and the status page read how old it is.
const heartbeatSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, unique: true },
    at: { type: Date, required: true },
    lastResult: { type: mongoose.Schema.Types.Mixed },
  },
  { versionKey: false }
);

module.exports = mongoose.models.Heartbeat || mongoose.model('Heartbeat', heartbeatSchema);
