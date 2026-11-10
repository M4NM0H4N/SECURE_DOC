'use strict';

const config = require('./config/env');
const { connectDb } = require('./config/db');
const { prepareUploadDir } = require('./config/storage');
const { getStorage } = require('./storage');
const createApp = require('./app');
const { detectMode } = require('./config/transactions');
const worker = require('./services/notificationWorker');

async function main() {
  await connectDb(config.mongoUri);
  const mode = await detectMode();
  console.log(`MongoDB transaction mode: ${mode}` + (mode === 'standalone' ? ' (NOT atomic across documents; see docs/TRANSACTIONS.md)' : ''));

  // Fail at start-up, not on the first upload, if the document store is unusable.
  const store = getStorage();
  await store.check();
  console.log('Document storage: ' + store.name + (store.name === 's3' ? ' (bucket reachable)' : ''));
  const storage = config.storageDriver === 'local' ? prepareUploadDir(config) : { ephemeralRisk: false };
  if (storage.ephemeralRisk) {
    console.warn(
      'WARNING: UPLOAD_DIR is not set in production. Uploaded documents are stored inside the deployed app ' +
        'and will be LOST on redeploy/restart unless a persistent disk is mounted. See docs/DEPLOYMENT.md.'
    );
  }

  const app = createApp();
  const onListening = () => {
    console.log(`Server listening on ${config.host || 'all interfaces'}:${config.port} (${config.env})`);
  };
  console.log(`Mail provider: ${config.mailProvider}`);
  if (config.workerInline) {
    worker.start();
    console.log('Notification worker running inside this process (WORKER_INLINE=true)');
  } else {
    console.log('Notification worker not started here: run "npm run worker" as its own process (or set WORKER_INLINE=true).');
  }
  if (config.host) app.listen(config.port, config.host, onListening);
  else app.listen(config.port, onListening);
}

main().catch((err) => {
  console.error('Failed to start server:', err.message);
  process.exit(1);
});
