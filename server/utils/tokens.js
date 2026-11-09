'use strict';

const crypto = require('crypto');

// 256 random bits, URL-safe. Only the hash is ever stored.
const newToken = () => crypto.randomBytes(32).toString('base64url');
const hashToken = (token) => crypto.createHash('sha256').update(String(token)).digest('hex');
// Anything that is not exactly a token we could have issued is rejected before the database.
const TOKEN_FORMAT = /^[A-Za-z0-9_-]{43}$/;
const looksLikeToken = (value) => typeof value === 'string' && TOKEN_FORMAT.test(value);

module.exports = { newToken, hashToken, looksLikeToken, TOKEN_FORMAT };
