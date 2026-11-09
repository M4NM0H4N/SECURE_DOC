'use strict';

const mongoose = require('mongoose');
const { ROLES, DEPARTMENTS } = require('../config/constants');

const userSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true, minlength: 2, maxlength: 100 },
    email: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      trim: true,
      maxlength: 254,
    },
    passwordHash: { type: String, required: true, select: false },
    role: { type: String, enum: Object.values(ROLES), required: true },
    // Required for STUDENT, CLERK and HOD (scope enforcement). Admin has none.
    department: {
      type: String,
      enum: DEPARTMENTS,
      default: null,
      required() {
        return this.role !== ROLES.ADMIN;
      },
    },
    isActive: { type: Boolean, default: true },
  },
  { timestamps: true }
);

userSchema.set('toJSON', {
  transform(_doc, ret) {
    delete ret.passwordHash;
    delete ret.__v;
    return ret;
  },
});

module.exports = mongoose.model('User', userSchema);
