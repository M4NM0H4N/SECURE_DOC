'use strict';

const { fail } = require('../utils/response');

function notFound(_req, res) {
  return fail(res, 404, 'Resource not found');
}

// eslint-disable-next-line no-unused-vars
function errorHandler(err, _req, res, _next) {
  if (err.isAppError) {
    return fail(res, err.status, err.message, err.errors);
  }
  if (err.type === 'entity.parse.failed') {
    return fail(res, 400, 'Malformed JSON body');
  }
  if (err.type === 'entity.too.large') {
    return fail(res, 413, 'Request body too large');
  }
  if (err.code === 11000) {
    return fail(res, 409, 'A record with this value already exists');
  }
  if (err.name === 'ValidationError' || err.name === 'CastError') {
    return fail(res, 400, 'Invalid data');
  }
  // Log server-side only; never leak internals to the client.
  if (process.env.NODE_ENV !== 'test') {
    console.error('Unhandled error:', err.message);
  }
  return fail(res, 500, 'Internal server error');
}

module.exports = { notFound, errorHandler };
