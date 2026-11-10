'use strict';

// code: NOT_FOUND | INVALID_KEY | FAILED
class StorageError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'StorageError';
    this.code = code;
  }
}

// Keys are `<tenantId>/<requestId>/<uuid>.<ext>`. Anything else is refused before any I/O, which
// is what stops a tampered database value from reaching the filesystem or the bucket.
const KEY_PATTERN = /^[0-9a-f]{24}\/[0-9a-f]{24}\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(pdf|png|jpg)$/;

function assertKey(key) {
  if (typeof key !== 'string' || !KEY_PATTERN.test(key)) throw new StorageError('INVALID_KEY', 'Invalid storage key');
}

module.exports = { StorageError, KEY_PATTERN, assertKey };
