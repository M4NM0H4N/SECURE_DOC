'use strict';

const net = require('net');
const config = require('../config/env');
const AppError = require('../utils/AppError');

// Talks to a ClamAV daemon (clamd) over TCP using the INSTREAM command:
//   "zINSTREAM\0", then chunks of [4-byte big-endian length][data], then a zero-length chunk;
//   the reply is "stream: OK", "stream: <Signature> FOUND" or "... ERROR".
const CHUNK = 64 * 1024;

function instream(buffer, { host, port, timeoutMs }) {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host, port });
    const chunks = [];
    let done = false;
    const finish = (err, value) => {
      if (done) return;
      done = true;
      socket.destroy();
      if (err) reject(err);
      else resolve(value);
    };
    socket.setTimeout(timeoutMs, () => finish(new Error('clamd timed out')));
    socket.on('error', finish);
    socket.on('data', (d) => chunks.push(d));
    socket.on('end', () => {
      const reply = Buffer.concat(chunks).toString('utf8').replace(/\0/g, '').trim();
      if (/\sFOUND$/.test(reply)) return finish(null, { infected: true, signature: reply.replace(/^stream:\s*/, '').replace(/\sFOUND$/, '') });
      if (/\bOK$/.test(reply)) return finish(null, { infected: false });
      return finish(new Error('clamd returned an unexpected reply'));
    });
    socket.on('connect', () => {
      socket.write('zINSTREAM\0');
      for (let i = 0; i < buffer.length; i += CHUNK) {
        const part = buffer.subarray(i, i + CHUNK);
        const len = Buffer.alloc(4);
        len.writeUInt32BE(part.length);
        socket.write(len);
        socket.write(part);
      }
      socket.write(Buffer.alloc(4)); // end of stream
    });
  });
}

/**
 * Scans an uploaded file. Returns { status: 'skipped' | 'clean' | 'infected' | 'unavailable' }.
 *   off       never scans.
 *   optional  scans; if the scanner cannot be reached the upload is allowed (status 'unavailable').
 *   required  scans; if the scanner cannot be reached the upload is REFUSED (503). Fails closed.
 */
async function scan(buffer) {
  const mode = config.scanMode;
  if (mode === 'off') return { status: 'skipped' };
  try {
    const result = await instream(buffer, config.clamd);
    return result.infected ? { status: 'infected', signature: result.signature } : { status: 'clean' };
  } catch (_err) {
    if (mode === 'optional') return { status: 'unavailable' };
    throw new AppError(503, 'Document scanning is unavailable. Please try again later.');
  }
}

module.exports = { scan, instream };
