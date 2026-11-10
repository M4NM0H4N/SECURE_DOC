'use strict';

// The notification worker as its own process: delivers queued e-mail and watches SLA timers.
//   npm run worker            run until stopped
//   npm run worker -- --once  one pass, then exit (for a cron job)
// It needs the same MONGODB_URI and mail settings as the web app. It prints counts only, never
// addresses, links or connection strings. Several workers may run at once: claims are atomic.
require('dotenv').config({ quiet: true });
const mongoose = require('mongoose');
const config = require('../server/config/env');
const worker = require('../server/services/notificationWorker');

(async () => {
  if (!config.mongoUri) throw new Error('MONGODB_URI is not set');
  await mongoose.connect(config.mongoUri);
  console.log(`Notification worker started (mail provider: ${config.mailProvider}).`);

  if (process.argv.includes('--once')) {
    console.log(JSON.stringify(await worker.runOnce()));
    await mongoose.disconnect();
    return;
  }
  const stop = worker.start();
  const shutdown = async () => {
    stop();
    await mongoose.disconnect();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
})().catch((err) => {
  console.error('Worker failed:', err.message);
  process.exit(1);
});
