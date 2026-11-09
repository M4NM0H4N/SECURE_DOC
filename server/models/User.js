'use strict';

const mongoose = require('mongoose');
const { ROLES, DEPARTMENT_ROLES } = require('../config/constants');
const tenantScope = require('./plugins/tenantScope');

const userSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true, minlength: 2, maxlength: 100 },
    email: {
      type: String,
      required: true,
      lowercase: true,
      trim: true,
      maxlength: 254,
    },
    passwordHash: { type: String, required: true, select: false },
    role: { type: String, enum: Object.values(ROLES), required: true },
    // Required for STUDENT, CLERK and HOD (scope enforcement). Admin, Principal and the
    // platform owner have none. The value is a department code from the institution's own
    // list; the services check it against that list (it is data, not an enum, since S2).
    department: {
      type: String,
      default: null,
      trim: true,
      uppercase: true,
      maxlength: 10,
      required() {
        return DEPARTMENT_ROLES.includes(this.role);
      },
    },
    isActive: { type: Boolean, default: true },
  },
  { timestamps: true }
);

// Staff and students always belong to a tenant; only a SUPER_ADMIN has none.
userSchema.plugin(tenantScope, {
  required() {
    return this.role !== ROLES.SUPER_ADMIN;
  },
});
// The same email may exist in two institutions, never twice in one.
userSchema.index({ tenantId: 1, email: 1 }, { unique: true });

userSchema.set('toJSON', {
  transform(_doc, ret) {
    delete ret.passwordHash;
    delete ret.__v;
    return ret;
  },
});

module.exports = mongoose.model('User', userSchema);
