'use strict';

const multer = require('multer');
const config = require('../config/env');
const AppError = require('../utils/AppError');

// Memory storage: the file is validated (magic bytes) before anything touches disk.
const uploader = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: config.maxUploadBytes, files: 1, fields: 5, parts: 6 },
}).single('document');

function uploadSingle(req, res, next) {
  uploader(req, res, (err) => {
    if (!err) return next();
    if (err.code === 'LIMIT_FILE_SIZE') {
      return next(new AppError(413, `File too large (maximum ${Math.round(config.maxUploadBytes / 1024 / 1024)} MB)`));
    }
    if (err instanceof multer.MulterError) {
      return next(new AppError(400, 'Invalid upload: send exactly one file in the "document" field'));
    }
    return next(new AppError(400, 'Invalid upload request'));
  });
}

module.exports = uploadSingle;
