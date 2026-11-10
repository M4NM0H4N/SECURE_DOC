'use strict';

// AWS Signature Version 4 request signing, for S3-compatible object stores (Cloudflare R2,
// AWS S3, MinIO). Written against Node's crypto instead of the AWS SDK: it is small, has no
// dependencies, and is verified against the examples published in the AWS documentation
// (server/tests/storage.test.js), so a mistake here would show up as a failing vector.
const crypto = require('crypto');

const sha256Hex = (data) => crypto.createHash('sha256').update(data).digest('hex');
const hmac = (key, data) => crypto.createHmac('sha256', key).update(data).digest();

// RFC 3986 encoding as AWS requires: unreserved characters stay, everything else is %XX.
function uriEncode(value) {
  return encodeURIComponent(value).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}
const encodePath = (path) => path.split('/').map(uriEncode).join('/');

function canonicalQuery(query) {
  return Object.keys(query)
    .sort()
    .map((k) => `${uriEncode(k)}=${uriEncode(String(query[k]))}`)
    .join('&');
}

function amzTimestamp(date) {
  return date.toISOString().replace(/[:-]|\.\d{3}/g, ''); // 20130524T000000Z
}

/**
 * Returns the headers to send (including Authorization). `headers` are any extra headers to
 * sign (content-type, range, x-amz-*). `host`, `x-amz-date` and `x-amz-content-sha256` are
 * always signed.
 */
function sign({ method, host, path, query = {}, headers = {}, payloadHash, accessKeyId, secretAccessKey, region, service = 's3', date = new Date() }) {
  const amzDate = amzTimestamp(date);
  const dateStamp = amzDate.slice(0, 8);

  const all = { host, 'x-amz-content-sha256': payloadHash, 'x-amz-date': amzDate };
  for (const [k, v] of Object.entries(headers)) all[k.toLowerCase()] = String(v).trim().replace(/\s+/g, ' ');
  const names = Object.keys(all).sort();
  const canonicalHeaders = names.map((n) => `${n}:${all[n]}\n`).join('');
  const signedHeaders = names.join(';');

  const canonicalRequest = [method, encodePath(path), canonicalQuery(query), canonicalHeaders, signedHeaders, payloadHash].join('\n');
  const scope = `${dateStamp}/${region}/${service}/aws4_request`;
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256Hex(canonicalRequest)].join('\n');

  const kDate = hmac(`AWS4${secretAccessKey}`, dateStamp);
  const kRegion = hmac(kDate, region);
  const kService = hmac(kRegion, service);
  const kSigning = hmac(kService, 'aws4_request');
  const signature = crypto.createHmac('sha256', kSigning).update(stringToSign).digest('hex');

  return {
    signature,
    canonicalRequest,
    stringToSign,
    headers: {
      ...all,
      authorization: `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
    },
  };
}

module.exports = { sign, sha256Hex, uriEncode, encodePath, canonicalQuery, amzTimestamp };
