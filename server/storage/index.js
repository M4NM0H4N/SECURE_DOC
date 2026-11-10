'use strict';

const crypto = require('crypto');
const config = require('../config/env');
const LocalAdapter = require('./localAdapter');
const S3Adapter = require('./s3Adapter');

let instance = null;

// The adapter chosen by STORAGE_DRIVER. Everything else in the app talks to this interface:
//   put(key, buffer) get(key) -> { stream, size } exists(key) delete(key) list() check()
function getStorage() {
  if (!instance) instance = config.storageDriver === 's3' ? new S3Adapter(config.s3) : new LocalAdapter(config.uploadDir);
  return instance;
}

// Test hook: run the same suite against another adapter. Not available in production.
function useStorage(adapter) {
  if (process.env.NODE_ENV === 'production') throw new Error('useStorage is a test hook');
  instance = adapter;
}

// <tenantId>/<requestId>/<random>.<ext>: tenant-prefixed, unguessable, no user input.
const makeKey = (tenantId, requestId, ext) => `${tenantId}/${requestId}/${crypto.randomUUID()}.${ext}`;

module.exports = { getStorage, useStorage, makeKey };
