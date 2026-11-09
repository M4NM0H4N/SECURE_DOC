'use strict';

// Outgoing mail interface. Real delivery (provider, templates, queue, retries) arrives in S5.
// Until then:
//   development and tests: messages are kept in a small in-memory outbox that tests read;
//   production: nothing is sent, and the message (which contains a secret link) is NOT logged.
// Callers must never depend on delivery succeeding; the Admin can hand out links directly
// (invites, reset links) and sees them once on screen.
const config = require('../config/env');

const MAX_OUTBOX = 100;
const outbox = [];

async function send({ to, template, data }) {
  if (config.isProd) return { delivered: false, reason: 'no mail provider configured' };
  outbox.push({ to, template, data, at: new Date() });
  if (outbox.length > MAX_OUTBOX) outbox.shift();
  return { delivered: true, simulated: true };
}

// Test helpers (the outbox does not exist in production).
const sent = () => outbox.slice();
const lastTo = (to, template) => [...outbox].reverse().find((m) => m.to === to && (!template || m.template === template)) || null;
const clearOutbox = () => {
  outbox.length = 0;
};

module.exports = { send, sent, lastTo, clearOutbox };
