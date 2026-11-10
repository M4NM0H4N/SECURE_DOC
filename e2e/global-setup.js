'use strict';

// Before the browser tests: empty the local e2e database, then create the demo institution and accounts
// with the project's own seed script (the same one used for demos).
const { spawnSync } = require('child_process');
const path = require('path');
const mongoose = require('mongoose');
const { e2eUri, DEMO_PASSWORD } = require('./env');

module.exports = async () => {
  const uri = e2eUri();
  const conn = await mongoose.createConnection(uri).asPromise();
  try {
    await conn.dropDatabase(); // the guard in e2eUri() guarantees this is a local *e2e* database
  } finally {
    await conn.close();
  }
  const seed = spawnSync(process.execPath, [path.join(__dirname, '..', 'scripts', 'seedDemo.js')], {
    env: { ...process.env, NODE_ENV: 'development', MONGODB_URI: uri, DEMO_PASSWORD, MAIL_PROVIDER: 'outbox' },
    encoding: 'utf8',
  });
  if (seed.status !== 0) throw new Error('Seeding the e2e database failed: ' + (seed.stderr || seed.stdout));
};
