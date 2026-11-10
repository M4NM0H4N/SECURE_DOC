'use strict';

// Outgoing mail. Providers (MAIL_PROVIDER):
//   outbox  in memory, development and tests only (tests read it). Not allowed in production.
//   resend  Resend's HTTPS API (https://resend.com), over a plain HTTPS request: no SDK.
//   none    nothing is sent. The production default until a provider is configured; callers
//           that depend on mail check enabled() first.
// Messages are rendered from templates (mailTemplates.js). Security mail (invites, reset and
// verification links) contains a secret link: it is sent once and never stored or logged.
const http = require('http');
const https = require('https');
const config = require('../config/env');
const { render } = require('./mailTemplates');

const MAX_OUTBOX = 200;
const outbox = [];

const enabled = () => config.mailProvider !== 'none';

// One HTTPS call. Errors carry the status code only: a provider's response body can echo the
// request (including links) and must never reach logs or stored error text.
function postJson(urlString, headers, payload) {
  const url = new URL(urlString);
  const lib = url.protocol === 'http:' ? http : https;
  const body = Buffer.from(JSON.stringify(payload));
  return new Promise((resolve, reject) => {
    const req = lib.request(
      { protocol: url.protocol, hostname: url.hostname, port: url.port || undefined, path: url.pathname, method: 'POST', timeout: 15000, headers: { 'content-type': 'application/json', 'content-length': body.length, ...headers } },
      (res) => {
        res.resume();
        res.on('end', () => (res.statusCode >= 200 && res.statusCode < 300 ? resolve() : reject(new Error(`Mail provider returned ${res.statusCode}`))));
      }
    );
    req.on('timeout', () => req.destroy(new Error('Mail provider timed out')));
    req.on('error', (err) => reject(new Error(err.message && /timed out/.test(err.message) ? 'Mail provider timed out' : 'Mail provider unreachable')));
    req.end(body);
  });
}

/**
 * Sends one message. Throws when it could not be delivered (the caller decides about retries).
 * `idempotencyKey` is passed to providers that support it so a retried send cannot duplicate.
 */
async function send({ to, template, data = {}, idempotencyKey }) {
  const message = render(template, data);
  if (config.mailProvider === 'outbox') {
    outbox.push({ to, template, data, message, at: new Date() });
    if (outbox.length > MAX_OUTBOX) outbox.shift();
    return { delivered: true, simulated: true };
  }
  if (config.mailProvider === 'resend') {
    const headers = { authorization: `Bearer ${config.resend.apiKey}` };
    if (idempotencyKey) headers['idempotency-key'] = String(idempotencyKey);
    await postJson(`${config.resend.apiUrl}/emails`, headers, { from: config.mailFrom, to: [to], subject: message.subject, text: message.text, html: message.html });
    return { delivered: true };
  }
  throw new Error('No mail provider is configured');
}

// Test helpers (the outbox does not exist in production).
const sent = () => outbox.slice();
const lastTo = (to, template) => [...outbox].reverse().find((m) => m.to === to && (!template || m.template === template)) || null;
const clearOutbox = () => {
  outbox.length = 0;
};

module.exports = { send, enabled, sent, lastTo, clearOutbox };
