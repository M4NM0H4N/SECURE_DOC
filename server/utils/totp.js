'use strict';

// RFC 6238 time-based one-time passwords (HMAC-SHA1, 30 s steps, 6 digits), as used by
// Google Authenticator, Microsoft Authenticator, Authy and others. Written against Node's
// crypto instead of a library: it is about forty lines, has no dependencies, and is checked
// against the RFC's published test vectors (server/tests/accounts.test.js).
const crypto = require('crypto');

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const STEP_SECONDS = 30;
const DIGITS = 6;

function base32Encode(buf) {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

function base32Decode(text) {
  const clean = String(text).toUpperCase().replace(/=+$/, '');
  let bits = 0;
  let value = 0;
  const out = [];
  for (const ch of clean) {
    const idx = ALPHABET.indexOf(ch);
    if (idx === -1) throw new Error('Invalid base32 secret');
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

const generateSecret = () => base32Encode(crypto.randomBytes(20)); // 160 bits, as the RFC recommends

function hotp(secretBytes, counter, digits = DIGITS) {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const hmac = crypto.createHmac('sha1', secretBytes).update(msg).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const bin = ((hmac[offset] & 0x7f) << 24) | (hmac[offset + 1] << 16) | (hmac[offset + 2] << 8) | hmac[offset + 3];
  return String(bin % 10 ** digits).padStart(digits, '0');
}

const stepOf = (nowMs) => Math.floor(nowMs / 1000 / STEP_SECONDS);

function generate(secret, nowMs = Date.now(), digits = DIGITS) {
  return hotp(base32Decode(secret), stepOf(nowMs), digits);
}

// Accepts the current step and one step either side (clock drift). Returns the matched step so the
// caller can refuse to accept the same step twice.
function verify(secret, token, nowMs = Date.now(), window = 1) {
  if (typeof token !== 'string' || !/^\d{6}$/.test(token)) return { valid: false };
  const key = base32Decode(secret);
  const current = stepOf(nowMs);
  for (let delta = -window; delta <= window; delta += 1) {
    const expected = Buffer.from(hotp(key, current + delta));
    if (crypto.timingSafeEqual(expected, Buffer.from(token))) return { valid: true, timeStep: current + delta };
  }
  return { valid: false };
}

function otpauthUrl({ issuer, label, secret }) {
  const l = encodeURIComponent(`${issuer}:${label}`);
  return `otpauth://totp/${l}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=${DIGITS}&period=${STEP_SECONDS}`;
}

module.exports = { generateSecret, generate, verify, otpauthUrl, base32Encode, base32Decode, hotp, stepOf };
