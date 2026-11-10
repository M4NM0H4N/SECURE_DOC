'use strict';

const http = require('http');
const https = require('https');
const { sign, sha256Hex, encodePath, canonicalQuery } = require('./sigv4');
const { StorageError, assertKey } = require('./errors');

const CONTENT_TYPES = { pdf: 'application/pdf', png: 'image/png', jpg: 'image/jpeg' };
const decodeXml = (s) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');

// S3-compatible object storage over a PRIVATE bucket (path-style URLs, which R2, S3 and MinIO
// all accept). Requests are signed with SigV4; nothing is ever made public and downloads are
// streamed through the API after authorisation.
class S3Adapter {
  constructor({ endpoint, bucket, accessKeyId, secretAccessKey, region }) {
    this.url = new URL(endpoint);
    this.bucket = bucket;
    this.accessKeyId = accessKeyId;
    this.secretAccessKey = secretAccessKey;
    this.region = region || 'auto';
    this.name = 's3';
    this.lib = this.url.protocol === 'http:' ? http : https;
  }

  // Sends one signed request. Resolves with the raw response (caller consumes or drains it).
  request({ method, key = '', query = {}, body = null, headers = {} }) {
    const path = `/${this.bucket}${key ? `/${key}` : ''}`;
    const payloadHash = sha256Hex(body || '');
    const signed = sign({
      method, host: this.url.host, path, query, headers, payloadHash,
      accessKeyId: this.accessKeyId, secretAccessKey: this.secretAccessKey, region: this.region,
    });
    const qs = canonicalQuery(query);
    const reqHeaders = { ...signed.headers };
    delete reqHeaders.host; // set by Node from the URL
    if (body) reqHeaders['content-length'] = body.length;

    return new Promise((resolve, reject) => {
      const req = this.lib.request(
        { protocol: this.url.protocol, hostname: this.url.hostname, port: this.url.port || undefined, method, path: `${encodePath(path)}${qs ? `?${qs}` : ''}`, headers: reqHeaders, timeout: 30000 },
        resolve
      );
      req.on('timeout', () => req.destroy(new Error('Object storage request timed out')));
      req.on('error', reject);
      if (body) req.write(body);
      req.end();
    });
  }

  async readAll(res) {
    const chunks = [];
    for await (const c of res) chunks.push(c);
    return Buffer.concat(chunks);
  }

  async fail(res, what) {
    // Drain, and never put provider error bodies (which can echo request details) in messages.
    await this.readAll(res).catch(() => {});
    throw new StorageError(res.statusCode === 404 ? 'NOT_FOUND' : 'FAILED', `Object storage ${what} failed (${res.statusCode})`);
  }

  async put(key, buffer) {
    assertKey(key);
    const type = CONTENT_TYPES[key.split('.').pop()];
    const res = await this.request({ method: 'PUT', key, body: buffer, headers: { 'content-type': type } });
    if (res.statusCode !== 200) await this.fail(res, 'upload');
    await this.readAll(res);
  }

  async get(key) {
    assertKey(key);
    const res = await this.request({ method: 'GET', key });
    if (res.statusCode !== 200) await this.fail(res, 'download');
    return { stream: res, size: Number(res.headers['content-length']) || undefined };
  }

  async exists(key) {
    assertKey(key);
    const res = await this.request({ method: 'HEAD', key });
    await this.readAll(res);
    if (res.statusCode === 200) return true;
    if (res.statusCode === 404) return false;
    throw new StorageError('FAILED', `Object storage check failed (${res.statusCode})`);
  }

  async delete(key) {
    assertKey(key);
    const res = await this.request({ method: 'DELETE', key });
    await this.readAll(res);
    if (![200, 204, 404].includes(res.statusCode)) throw new StorageError('FAILED', `Object storage delete failed (${res.statusCode})`);
  }

  async deleteRaw(key) {
    const res = await this.request({ method: 'DELETE', key });
    await this.readAll(res);
    if (![200, 204, 404].includes(res.statusCode)) throw new StorageError('FAILED', `Object storage delete failed (${res.statusCode})`);
  }

  // All objects: [{ key, size, modifiedAt }], following continuation tokens.
  async list() {
    const out = [];
    let token;
    do {
      const query = { 'list-type': '2' };
      if (token) query['continuation-token'] = token;
      const res = await this.request({ method: 'GET', query });
      if (res.statusCode !== 200) await this.fail(res, 'listing');
      const xml = (await this.readAll(res)).toString('utf8');
      for (const m of xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)) {
        const key = /<Key>([\s\S]*?)<\/Key>/.exec(m[1]);
        const size = /<Size>(\d+)<\/Size>/.exec(m[1]);
        const modified = /<LastModified>([^<]+)<\/LastModified>/.exec(m[1]);
        if (key) out.push({ key: decodeXml(key[1]), size: size ? Number(size[1]) : 0, modifiedAt: modified ? new Date(modified[1]) : new Date() });
      }
      const next = /<NextContinuationToken>([^<]+)<\/NextContinuationToken>/.exec(xml);
      token = /<IsTruncated>true<\/IsTruncated>/.test(xml) && next ? decodeXml(next[1]) : null;
    } while (token);
    return out;
  }

  // Start-up check: the credentials work and the bucket is reachable (a one-item listing).
  async check() {
    const res = await this.request({ method: 'GET', query: { 'list-type': '2', 'max-keys': '1' } });
    if (res.statusCode !== 200) await this.fail(res, 'start-up check');
    await this.readAll(res);
  }
}

module.exports = S3Adapter;
