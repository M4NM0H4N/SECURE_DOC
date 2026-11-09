'use strict';

const config = require('./config/env');
const { connectDb } = require('./config/db');
const { prepareUploadDir } = require('./config/storage');
const createApp = require('./app');
const { detectMode } = require('./config/transactions');

async function main() {
  await connectDb(config.mongoUri);
  const mode = await detectMode();
  console.log(`MongoDB transaction mode: ${mode}` + (mode === 'standalone' ? ' (NOT atomic across documents; see docs/TRANSACTIONS.md)' : ''));

  const storage = prepareUploadDir(config);
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
  if (config.host) app.listen(config.port, config.host, onListening);
  else app.listen(config.port, onListening);
}

main().catch((err) => {
  console.error('Failed to start server:', err.message);
  process.exit(1);
});
