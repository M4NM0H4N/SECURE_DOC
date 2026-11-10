'use strict';

const config = require('./config/env');
const { connectDb } = require('./config/db');
const { prepareUploadDir } = require('./config/storage');
const { getStorage } = require('./storage');
const createApp = require('./app');
const { detectMode } = require('./config/transactions');
const worker = require('./services/notificationWorker');
const { logger } = require('./utils/logger');

async function main() {
  await connectDb(config.mongoUri);
  const mode = await detectMode();
  logger.info('database ready', { transactionMode: mode, atomic: mode !== 'standalone' });

  // Fail at start-up, not on the first upload, if the document store is unusable.
  const store = getStorage();
  await store.check();
  logger.info('document storage ready', { driver: store.name });
  const storage = config.storageDriver === 'local' ? prepareUploadDir(config) : { ephemeralRisk: false };
  if (storage.ephemeralRisk) {
    logger.warn('UPLOAD_DIR is not set in production: uploaded documents will be lost on redeploy unless a persistent disk is mounted (docs/DEPLOYMENT.md)');
  }

  const app = createApp();
  const onListening = () => {
    logger.info('server listening', { port: config.port, env: config.env });
  };
  logger.info('mail provider', { provider: config.mailProvider });
  if (config.workerInline) {
    worker.start();
    logger.info('notification worker running inside this process');
  } else {
    logger.info('notification worker not started here: run npm run worker as its own process or set WORKER_INLINE=true');
  }
  if (config.host) app.listen(config.port, config.host, onListening);
  else app.listen(config.port, onListening);
}

main().catch((err) => {
  logger.error('failed to start server', { error: err.message });
  process.exit(1);
});
