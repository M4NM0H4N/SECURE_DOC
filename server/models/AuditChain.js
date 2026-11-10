'use strict';

const mongoose = require('mongoose');
const tenantScope = require('./plugins/tenantScope');

// The head of one institution's audit hash chain (tenantId null = platform events): how many entries
// are chained and the hash of the last one. Appending moves it forward with a compare-and-swap in the
// same transaction as the new entry, so entries are strictly ordered even with concurrent writers,
// and removing the newest entries is detected because the head still remembers them.
const auditChainSchema = new mongoose.Schema(
  {
    seq: { type: Number, required: true, min: 0 },
    lastHash: { type: String, required: true },
  },
  { timestamps: true }
);

auditChainSchema.plugin(tenantScope, { required: false, index: false }); // the unique index below covers tenantId
auditChainSchema.index({ tenantId: 1 }, { unique: true });

module.exports = mongoose.model('AuditChain', auditChainSchema);
