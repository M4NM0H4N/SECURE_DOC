'use strict';

// Logical backup and restore of the whole database, with no external tools.
//
// A backup is a folder: one NDJSON file per collection (Extended JSON, so ObjectIds, dates and
// binary survive exactly) plus manifest.json with counts, SHA-256 of each file and the indexes.
// Files may be encrypted with AES-256-GCM (BACKUP_ENCRYPTION_KEY); the backup contains personal data
// and password hashes, so unencrypted copies must live only on storage you already trust.
//
// Safety rules built in:
//  * restore refuses a target database that already holds data (it never overwrites or merges);
//  * the manifest is verified (hashes, counts) before a single document is written;
//  * nothing here logs a connection string, document content or key.
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const readline = require('readline');
const { once } = require('events');
const { EJSON } = require('mongoose').mongo.BSON;
const auditService = require('../services/auditService');

const FORMAT = 1;
const BATCH = 500;
const EJSON_OPTS = { relaxed: false };

function keyFrom(secret) {
  if (!secret) return null;
  if (secret.length < 32) throw new Error('BACKUP_ENCRYPTION_KEY must be at least 32 characters');
  return crypto.createHash('sha256').update(secret).digest();
}

async function listCollections(db) {
  const all = await db.listCollections({}, { nameOnly: true }).toArray();
  return all.filter((c) => !c.name.startsWith('system.')).map((c) => c.name).sort();
}

async function backupDb(db, dir, { encryptionKey } = {}) {
  const key = keyFrom(encryptionKey);
  await fsp.mkdir(dir, { recursive: true });
  if ((await fsp.readdir(dir)).length) throw new Error('The backup folder is not empty; choose a new one');
  const manifest = { format: FORMAT, createdAt: new Date().toISOString(), encrypted: Boolean(key), collections: {} };

  for (const name of await listCollections(db)) {
    const file = `${name}.ndjson`;
    const out = fs.createWriteStream(path.join(dir, file));
    const sha = crypto.createHash('sha256');
    let cipher = null;
    let iv = null;
    if (key) {
      iv = crypto.randomBytes(12);
      cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    }
    const emit = async (buf) => {
      sha.update(buf);
      if (!out.write(buf)) await once(out, 'drain');
    };
    let count = 0;
    for await (const doc of db.collection(name).find({})) {
      const line = Buffer.from(`${EJSON.stringify(doc, EJSON_OPTS)}\n`);
      await emit(cipher ? cipher.update(line) : line);
      count += 1;
    }
    if (cipher) await emit(cipher.final());
    out.end();
    await once(out, 'finish');
    const indexes = (await db.collection(name).indexes()).filter((i) => i.name !== '_id_');
    manifest.collections[name] = { file, count, sha256: sha.digest('hex'), indexes, ...(cipher ? { iv: iv.toString('hex'), tag: cipher.getAuthTag().toString('hex') } : {}) };
  }
  await fsp.writeFile(path.join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2));
  return summary(manifest);
}

const summary = (m) => ({
  collections: Object.keys(m.collections).length,
  documents: Object.values(m.collections).reduce((n, c) => n + c.count, 0),
  encrypted: m.encrypted,
  createdAt: m.createdAt,
});

async function readManifest(dir) {
  const m = JSON.parse(await fsp.readFile(path.join(dir, 'manifest.json'), 'utf8'));
  if (m.format !== FORMAT) throw new Error('Unsupported backup format');
  return m;
}

function sha256File(file) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    fs.createReadStream(file).on('data', (d) => h.update(d)).on('error', reject).on('end', () => resolve(h.digest('hex')));
  });
}

// Checks every file against the manifest without touching any database. Returns the manifest.
async function verifyBackup(dir, { encryptionKey } = {}) {
  const m = await readManifest(dir);
  if (m.encrypted && !encryptionKey) throw new Error('This backup is encrypted: BACKUP_ENCRYPTION_KEY is required');
  for (const [name, c] of Object.entries(m.collections)) {
    if ((await sha256File(path.join(dir, c.file))) !== c.sha256) throw new Error(`Backup file for "${name}" is damaged (checksum mismatch)`);
  }
  return m;
}

function openLines(dir, c, key) {
  let input = fs.createReadStream(path.join(dir, c.file));
  if (c.iv) {
    const d = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(c.iv, 'hex'));
    d.setAuthTag(Buffer.from(c.tag, 'hex'));
    input = input.pipe(d);
    input.on('error', () => {});
  }
  return readline.createInterface({ input, crlfDelay: Infinity });
}

async function restoreDb(db, dir, { encryptionKey } = {}) {
  const key = keyFrom(encryptionKey);
  const m = await verifyBackup(dir, { encryptionKey });
  if ((await listCollections(db)).length) throw new Error('The target database is not empty; restore only into an empty database');
  const restored = {};
  for (const [name, c] of Object.entries(m.collections)) {
    const col = db.collection(name);
    let batch = [];
    let n = 0;
    const flush = async () => {
      if (!batch.length) return;
      await col.insertMany(batch, { ordered: true });
      n += batch.length;
      batch = [];
    };
    for await (const line of openLines(dir, c, key)) {
      if (!line) continue;
      batch.push(EJSON.parse(line, EJSON_OPTS));
      if (batch.length >= BATCH) await flush();
    }
    await flush();
    if (n !== c.count) throw new Error(`Restored ${n} of ${c.count} documents for "${name}"`);
    for (const ix of c.indexes) {
      const opts = { ...ix };
      const spec = opts.key;
      for (const k of ['key', 'v', 'ns']) delete opts[k]; // version and namespace are the server's own
      await col.createIndex(spec, opts);
    }
    if (c.count === 0) await db.createCollection(name).catch(() => {});
    restored[name] = n;
  }
  return { ...summary(m), restored };
}

// Recomputes every institution's audit hash chain straight from the raw documents.
async function verifyAuditChains(db) {
  const results = { tenants: 0, entries: 0, broken: [] };
  const col = db.collection('auditlogs');
  const heads = new Map((await db.collection('auditchains').find({}).toArray()).map((h) => [String(h.tenantId), h]));
  const tenantIds = await col.distinct('tenantId');
  for (const tid of tenantIds) {
    results.tenants += 1;
    let prev = 'GENESIS';
    let expected = 1;
    let bad = null;
    for await (const e of col.find({ tenantId: tid, seq: { $ne: null } }).sort({ seq: 1 })) {
      results.entries += 1;
      const ok = e.seq === expected && e.prevHash === prev && auditService.entryHash(e) === e.hash;
      if (!ok && !bad) bad = { tenantId: String(tid), seq: e.seq };
      prev = e.hash;
      expected = e.seq + 1;
    }
    const head = heads.get(String(tid));
    if (!bad && head && (head.seq !== expected - 1 || head.lastHash !== prev)) bad = { tenantId: String(tid), seq: expected };
    if (bad) results.broken.push(bad);
  }
  return { ok: results.broken.length === 0, ...results };
}

// Backup -> restore into a throw-away database -> compare. `dropDb` is only ever called on the
// database this function created itself (its name must contain "_drill_").
async function drill(client, sourceName, workDir, { encryptionKey } = {}) {
  const started = Date.now();
  const drillName = `${sourceName}_drill_${crypto.randomBytes(4).toString('hex')}`;
  const dir = path.join(workDir, `drill-${Date.now()}`);
  const source = client.db(sourceName);
  const target = client.db(drillName);
  try {
    const backup = await backupDb(source, dir, { encryptionKey });
    const restore = await restoreDb(target, dir, { encryptionKey });
    const mismatches = [];
    for (const name of await listCollections(source)) {
      const [a, b] = await Promise.all([source.collection(name).countDocuments({}), target.collection(name).countDocuments({})]);
      if (a !== b) mismatches.push({ collection: name, source: a, restored: b });
    }
    const chains = await verifyAuditChains(target);
    return {
      ok: mismatches.length === 0 && chains.ok,
      backup, restoredDocuments: restore.documents, mismatches, auditChains: chains,
      seconds: Math.round((Date.now() - started) / 100) / 10,
    };
  } finally {
    if (drillName.includes('_drill_')) await target.dropDatabase().catch(() => {});
    await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

module.exports = { backupDb, restoreDb, verifyBackup, verifyAuditChains, drill, listCollections };
