'use strict';

const fs = require('fs');

/**
 * Makes sure the private upload folder exists and is writable, so a bad mount or
 * permission problem fails at startup instead of on the first upload.
 *
 * Returns { path, ephemeralRisk }. `ephemeralRisk` is true in production when
 * UPLOAD_DIR was not set: the default folder lives inside the deployed app, and on
 * hosts such as Render the ordinary filesystem is wiped on every deploy/restart,
 * which would make already-issued documents disappear.
 */
function prepareUploadDir(config) {
  fs.mkdirSync(config.uploadDir, { recursive: true });
  fs.accessSync(config.uploadDir, fs.constants.W_OK);
  return {
    path: config.uploadDir,
    ephemeralRisk: Boolean(config.isProd && config.uploadDirIsDefault),
  };
}

module.exports = { prepareUploadDir };
