'use strict';

const mongoose = require('mongoose');
const tenantScope = require('./plugins/tenantScope');

// An institution's own department list (replaces the MVP's fixed enum). The code is what
// users and requests store and is immutable; names can be edited; departments are
// deactivated, never deleted, so history keeps making sense.
const departmentSchema = new mongoose.Schema(
  {
    code: { type: String, required: true, uppercase: true, trim: true, match: /^[A-Z0-9]{2,10}$/ },
    name: { type: String, required: true, trim: true, minlength: 2, maxlength: 100 },
    isActive: { type: Boolean, default: true },
  },
  { timestamps: true }
);

departmentSchema.plugin(tenantScope);
departmentSchema.index({ tenantId: 1, code: 1 }, { unique: true });

module.exports = mongoose.model('Department', departmentSchema);
