'use strict';

const mongoose = require('mongoose');

// Slugs become part of the URL (/t/<slug>/...), so they are strict and never reserved words.
const SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]{1,28}[a-z0-9])$/;
const RESERVED_SLUGS = Object.freeze(['api', 'admin', 'platform', 'signup', 't', 'www', 'static', 'assets', 'login', 'healthz']);

const tenantSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true, minlength: 2, maxlength: 120 },
    slug: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      trim: true,
      match: SLUG_PATTERN,
      validate: { validator: (v) => !RESERVED_SLUGS.includes(v), message: 'That institution address is reserved' },
    },
    status: { type: String, enum: ['ACTIVE', 'SUSPENDED'], default: 'ACTIVE', required: true },
  },
  { timestamps: true }
);

// Not tenant-scoped: this is the collection that defines tenants.
module.exports = mongoose.model('Tenant', tenantSchema);
module.exports.SLUG_PATTERN = SLUG_PATTERN;
module.exports.RESERVED_SLUGS = RESERVED_SLUGS;
