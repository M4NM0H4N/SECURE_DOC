'use strict';

// In-process stand-ins for the two external services S4 talks to, so the real adapters and the
// real scanner client are exercised over real sockets without any account or daemon.
const http = require('http');
const net = require('net');
const crypto = require('crypto');
const { sign, sha256Hex } = require('../storage/sigv4');

// ---- fake S3 ---------------------------------------------------------------------------------
// Verifies every request the way a real S3-compatible store does: the SigV4 signature (recomputed
// from the request as received), the clock, the credential and the payload hash. Anything else is
// refused with 403, so an adapter that signs wrongly fails loudly.
const FAKE_S3 = { accessKeyId: 'AKIA' + 'FAKEFAKEFAKEFAKE', secretAccessKey: 'fake-secret-key-for-tests-only-0123456789', region: 'auto', bucket: 'docflow-test' };

async function startFakeS3({ pageSize = 1000 } = {}) {
  const objects = new Map(); // key -> { body, modifiedAt }
  const log = [];
  const state = { failNext: 0, objects, log };

  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      const url = new URL(req.url, 'http://x');
      const reply = (status, text = '', headers = {}) => {
        res.writeHead(status, { 'content-length': Buffer.byteLength(text), ...headers });
        res.end(text);
      };

      // --- authenticate
      const auth = /^AWS4-HMAC-SHA256 Credential=([^/]+)\/(\d{8})\/([^/]+)\/s3\/aws4_request, SignedHeaders=([^,]+), Signature=([0-9a-f]{64})$/.exec(req.headers.authorization || '');
      if (!auth) return reply(403, '<Error><Code>AccessDenied</Code></Error>');
      const [, accessKey, , region, signedHeaders, signature] = auth;
      const amzDate = req.headers['x-amz-date'] || '';
      const when = new Date(`${amzDate.slice(0, 4)}-${amzDate.slice(4, 6)}-${amzDate.slice(6, 8)}T${amzDate.slice(9, 11)}:${amzDate.slice(11, 13)}:${amzDate.slice(13, 15)}Z`);
      if (accessKey !== FAKE_S3.accessKeyId || Number.isNaN(when.getTime()) || Math.abs(Date.now() - when.getTime()) > 15 * 60 * 1000) {
        return reply(403, '<Error><Code>InvalidAccessKeyId</Code></Error>');
      }
      if (req.headers['x-amz-content-sha256'] !== sha256Hex(body)) return reply(400, '<Error><Code>XAmzContentSHA256Mismatch</Code></Error>');
      const extra = {};
      for (const name of signedHeaders.split(';')) if (!['host', 'x-amz-date', 'x-amz-content-sha256'].includes(name)) extra[name] = req.headers[name];
      const path = decodeURIComponent(url.pathname); // the adapter signs the unencoded path
      const query = {};
      url.searchParams.forEach((v, k) => (query[k] = v));
      const expected = sign({
        method: req.method, host: req.headers.host, path, query, headers: extra, payloadHash: req.headers['x-amz-content-sha256'],
        accessKeyId: FAKE_S3.accessKeyId, secretAccessKey: FAKE_S3.secretAccessKey, region, date: when,
      });
      if (expected.signature !== signature) return reply(403, '<Error><Code>SignatureDoesNotMatch</Code></Error>');

      log.push({ method: req.method, path, query });
      if (state.failNext > 0) {
        state.failNext -= 1;
        return reply(500, '<Error><Code>InternalError</Code><Message>secret-detail-that-must-not-leak</Message></Error>');
      }

      // --- the bucket
      const prefix = `/${FAKE_S3.bucket}`;
      if (path !== prefix && !path.startsWith(`${prefix}/`)) return reply(404, '<Error><Code>NoSuchBucket</Code></Error>');
      const key = path.slice(prefix.length + 1);

      if (!key) {
        if (req.method !== 'GET') return reply(405);
        const all = [...objects.keys()].sort();
        const start = query['continuation-token'] ? all.indexOf(query['continuation-token']) : 0;
        const limit = Math.min(Number(query['max-keys']) || pageSize, pageSize);
        const page = all.slice(start, start + limit);
        const next = all[start + limit];
        const xml = `<?xml version="1.0"?><ListBucketResult><IsTruncated>${next ? 'true' : 'false'}</IsTruncated>${
          next ? `<NextContinuationToken>${next}</NextContinuationToken>` : ''
        }${page.map((k) => `<Contents><Key>${k}</Key><LastModified>${objects.get(k).modifiedAt.toISOString()}</LastModified><Size>${objects.get(k).body.length}</Size></Contents>`).join('')}</ListBucketResult>`;
        return reply(200, xml, { 'content-type': 'application/xml' });
      }
      if (req.method === 'PUT') {
        objects.set(key, { body, modifiedAt: new Date(), contentType: req.headers['content-type'] });
        return reply(200);
      }
      const obj = objects.get(key);
      if (req.method === 'GET' || req.method === 'HEAD') {
        if (!obj) return reply(404, '<Error><Code>NoSuchKey</Code></Error>');
        res.writeHead(200, { 'content-length': obj.body.length, 'content-type': obj.contentType || 'application/octet-stream' });
        return res.end(req.method === 'HEAD' ? undefined : obj.body);
      }
      if (req.method === 'DELETE') {
        objects.delete(key);
        return reply(204);
      }
      return reply(405);
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const endpoint = `http://127.0.0.1:${server.address().port}`;
  return { ...state, endpoint, config: { endpoint, bucket: FAKE_S3.bucket, accessKeyId: FAKE_S3.accessKeyId, secretAccessKey: FAKE_S3.secretAccessKey, region: FAKE_S3.region }, close: () => new Promise((r) => server.close(r)), state };
}

// ---- fake clamd --------------------------------------------------------------------------------
// Speaks the INSTREAM protocol. Built at run time so the repository never contains the EICAR
// string literally (some antivirus products flag files that do).
const EICAR = ['X5O!P%@AP[4\\PZX54(P^)7CC)7}$', 'EICAR-STANDARD-ANTIVIRUS-TEST-FILE!', '$H+H*'].join('');

async function startFakeClamd({ mode = 'normal' } = {}) {
  const state = { scans: 0, received: [], mode };
  const server = net.createServer((socket) => {
    let buf = Buffer.alloc(0);
    let gotCommand = false;
    const payload = [];
    socket.on('data', (d) => {
      buf = Buffer.concat([buf, d]);
      if (!gotCommand) {
        if (buf.length < 10) return;
        if (buf.subarray(0, 10).toString() !== 'zINSTREAM\0') return socket.destroy();
        gotCommand = true;
        buf = buf.subarray(10);
      }
      for (;;) {
        if (buf.length < 4) return;
        const len = buf.readUInt32BE(0);
        if (len === 0) {
          const data = Buffer.concat(payload);
          state.scans += 1;
          state.received.push(data);
          if (state.mode === 'hang') return; // never answers: exercises the client timeout
          if (state.mode === 'error') return socket.end('INSTREAM size limit exceeded. ERROR\0');
          if (state.mode === 'garbage') return socket.end('what?\0');
          return socket.end(data.includes(EICAR) ? 'stream: Eicar-Test-Signature FOUND\0' : 'stream: OK\0');
        }
        if (buf.length < 4 + len) return;
        payload.push(buf.subarray(4, 4 + len));
        buf = buf.subarray(4 + len);
      }
    });
    socket.on('error', () => {});
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { state, port: server.address().port, close: () => new Promise((r) => { server.close(r); server.closeAllConnections?.(); }) };
}

// A port nothing listens on (the scanner "is down").
async function closedPort() {
  const s = net.createServer();
  await new Promise((r) => s.listen(0, '127.0.0.1', r));
  const { port } = s.address();
  await new Promise((r) => s.close(r));
  return port;
}

module.exports = { startFakeS3, startFakeClamd, closedPort, EICAR, FAKE_S3, crypto };
