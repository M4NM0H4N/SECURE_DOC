'use strict';

const multer = require('multer');
const AppError = require('../utils/AppError');
const { MAX_LOGO_BYTES } = require('../services/brandingService');

const uploader = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_LOGO_BYTES, files: 1, fields: 2, parts: 3 } }).single('logo');

module.exports = (req, res, next) =>
  uploader(req, res, (err) => {
    if (!err) return next();
    if (err.code === 'LIMIT_FILE_SIZE') return next(new AppError(413, 'The logo is larger than 100 KB'));
    return next(new AppError(400, 'Invalid upload: send exactly one image in the "logo" field'));
  });
