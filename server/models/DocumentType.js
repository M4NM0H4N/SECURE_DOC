'use strict';

const mongoose = require('mongoose');
const tenantScope = require('./plugins/tenantScope');

// An institution's own document types (replaces the MVP's fixed enum). Requests store the
// type's name. Deactivated, never deleted.
const documentTypeSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true, minlength: 2, maxlength: 80 },
    // Lower-cased copy that makes "Transcript" and "transcript" the same type.
    nameKey: { type: String, required: true },
    isActive: { type: Boolean, default: true },
  },
  { timestamps: true }
);

documentTypeSchema.pre('validate', function setKey() {
  if (typeof this.name === 'string') this.nameKey = this.name.trim().toLowerCase();
});
documentTypeSchema.plugin(tenantScope);
documentTypeSchema.index({ tenantId: 1, nameKey: 1 }, { unique: true });

module.exports = mongoose.model('DocumentType', documentTypeSchema);
