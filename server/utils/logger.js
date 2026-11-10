'use strict';

// Structured logging: one JSON object per line on stdout, ready for any log service.
// Rules: no request bodies, no query strings, no headers, no e-mail addresses, tokens or
// connection strings ever appear in a line. Known-sensitive keys are masked, and anything that
// looks like a credential inside a message is redacted as a second line of defence.
const LEVELS = { debug: 10, info: 20, warn: 30, error: 40, silent: 100 };
const SENSITIVE_KEY = /pass(word)?|secret|token|authorization|cookie|key|uri|email|otp|code|signature|link/i;
const SENSITIVE_VALUE = [
  /mongodb(\+srv)?:\/\/[^\s"']+/gi,
  /\bBearer\s+[A-Za-z0-9._~+/=-]+/gi,
  /\bdfk_[A-Za-z0-9_-]+/g,
  /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]*/g,
];

function redactString(s) {
  let out = String(s);
  for (const re of SENSITIVE_VALUE) out = out.replace(re, '[redacted]');
  return out.length > 500 ? `${out.slice(0, 500)}...` : out;
}

function clean(value, depth = 0) {
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') return redactString(value);
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (value instanceof Error) return redactString(value.message);
  if (depth >= 3) return '[truncated]';
  if (Array.isArray(value)) return value.slice(0, 20).map((v) => clean(v, depth + 1));
  if (typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = SENSITIVE_KEY.test(k) ? '[redacted]' : clean(v, depth + 1);
    return out;
  }
  return String(value);
}

function createLogger({ level = process.env.LOG_LEVEL || (process.env.NODE_ENV === 'test' ? 'silent' : 'info'), write } = {}) {
  const threshold = LEVELS[level] ?? LEVELS.info;
  const sink = write || ((line) => process.stdout.write(`${line}\n`));
  const emit = (lvl, msg, fields) => {
    if (LEVELS[lvl] < threshold) return;
    const entry = { time: new Date().toISOString(), level: lvl, msg: redactString(msg), ...(fields ? clean(fields) : {}) };
    sink(JSON.stringify(entry));
  };
  return {
    debug: (m, f) => emit('debug', m, f),
    info: (m, f) => emit('info', m, f),
    warn: (m, f) => emit('warn', m, f),
    error: (m, f) => emit('error', m, f),
  };
}

// Process-wide logger. Tests replace the sink through setSink().
const logger = createLogger();
let override = null;
const proxy = {};
for (const lvl of ['debug', 'info', 'warn', 'error']) proxy[lvl] = (m, f) => (override || logger)[lvl](m, f);
proxy.setSink = (write, level = 'debug') => { override = write ? createLogger({ level, write }) : null; };

module.exports = { createLogger, logger: proxy, redactString, clean };
