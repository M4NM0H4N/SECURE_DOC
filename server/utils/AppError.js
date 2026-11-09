'use strict';

class AppError extends Error {
  constructor(status, message, errors) {
    super(message);
    this.status = status;
    this.errors = errors;
    this.isAppError = true;
  }
}

module.exports = AppError;
