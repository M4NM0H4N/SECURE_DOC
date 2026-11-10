'use strict';

// Logical backup, verification and restore. Never writes to the source database.
//   npm run backup -- --out backups/2026-11-10            back up MONGODB_URI into a NEW folder
//   npm run backup -- --verify backups/2026-11-10         check files against the manifest (no database)
//   npm run backup -- --restore backups/2026-11-10        restore into RESTORE_MONGODB_URI (must be EMPTY)
//   npm run backup -- --drill [--allow-remote]            backup + restore into a throw-away database + compare
// RESTORE_MONGODB_URI is deliberately separate from MONGODB_URI so a restore can never hit production by accident.
// BACKUP_ENCRYPTION_KEY (32+ chars) encrypts the files. Prints counts only, never URIs or content.
require('dotenv').config({ quiet: true });
const os = require('os');
const path = require('path');
const mongoose = require('mongoose');
const { backupDb, restoreDb, verifyBackup, drill } = require('../server/ops/backup');
const { isLocalMongoUri } = require('../server/config/mongoUri');

const arg = (n) => {
  const i = process.argv.indexOf(`--${n}`);
  return i > -1 ? process.argv[i + 1] : undefined;
};
const has = (n) => process.argv.includes(`--${n}`);
const encryptionKey = process.env.BACKUP_ENCRYPTION_KEY;

async function connect(uri) {
  if (!uri) throw new Error('A MongoDB URI is required (MONGODB_URI, or RESTORE_MONGODB_URI for restore)');
  const conn = await mongoose.createConnection(uri).asPromise();
  return conn;
}

(async () => {
  if (arg('verify')) {
    const m = await verifyBackup(path.resolve(arg('verify')), { encryptionKey });
    console.log(JSON.stringify({ verified: true, collections: Object.keys(m.collections).length, createdAt: m.createdAt, encrypted: m.encrypted }));
    return;
  }
  if (arg('out')) {
    const conn = await connect(process.env.MONGODB_URI);
    try {
      console.log(JSON.stringify(await backupDb(conn.db, path.resolve(arg('out')), { encryptionKey })));
    } finally {
      await conn.close();
    }
    return;
  }
  if (arg('restore')) {
    const conn = await connect(process.env.RESTORE_MONGODB_URI);
    try {
      console.log(JSON.stringify(await restoreDb(conn.db, path.resolve(arg('restore')), { encryptionKey })));
    } finally {
      await conn.close();
    }
    return;
  }
  if (has('drill')) {
    // The drill creates (and then drops) a temporary database next to the source. Against a hosted cluster that
    // needs a deliberate flag, so it is never run there by accident.
    if (!isLocalMongoUri(process.env.MONGODB_URI) && !has('allow-remote')) throw new Error('MONGODB_URI is not local: add --allow-remote to run the drill against a hosted cluster');
    const conn = await connect(process.env.MONGODB_URI);
    try {
      const result = await drill(conn.getClient(), conn.db.databaseName, os.tmpdir(), { encryptionKey });
      console.log(JSON.stringify(result, null, 2));
      if (!result.ok) process.exitCode = 1;
    } finally {
      await conn.close();
    }
    return;
  }
  console.log('Usage: backup.js --out <new folder> | --verify <folder> | --restore <folder> | --drill');
  process.exitCode = 2;
})().catch((e) => {
  console.error('Backup tool failed:', e.message);
  process.exit(1);
});
