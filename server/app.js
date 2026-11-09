'use strict';

const path = require('path');
const express = require('express');
const helmet = require('helmet');
const cookieParser = require('cookie-parser');
const mongoSanitize = require('express-mongo-sanitize');
const rateLimit = require('express-rate-limit');
const mongoose = require('mongoose');

const config = require('./config/env');
const csrf = require('./middleware/csrf');
const { notFound, errorHandler } = require('./middleware/errorHandler');
const authRoutes = require('./routes/authRoutes');
const adminRoutes = require('./routes/adminRoutes');
const requestRoutes = require('./routes/requestRoutes');

function createApp({
  authRateLimitMax = 20,
  uploadRateLimitMax = 30,
  apiRateLimitMax = 1000,
  trustProxy = config.trustProxy,
} = {}) {
  const app = express();
  app.disable('x-powered-by');
  // Behind a reverse proxy (Render) every request arrives from the proxy's address.
  // Trusting exactly N hops makes req.ip the real client, so per-IP rate limits work
  // and one noisy client cannot lock everyone else out.
  if (trustProxy) app.set('trust proxy', trustProxy);

  // Liveness/readiness probe for the host (Render health check). Public on purpose,
  // exposes no data and is not rate limited, so monitoring never trips a limit.
  app.get('/healthz', (_req, res) => {
    const connected = mongoose.connection.readyState === 1;
    res.set('Cache-Control', 'no-store');
    res.status(connected ? 200 : 503).json({ status: connected ? 'ok' : 'unavailable' });
  });

  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: ["'self'"],
          styleSrc: ["'self'", 'https://fonts.googleapis.com'],
          fontSrc: ["'self'", 'https://fonts.gstatic.com'],
          imgSrc: ["'self'", 'data:'],
          connectSrc: ["'self'"],
          objectSrc: ["'none'"],
          frameAncestors: ["'none'"],
          // Plain-http localhost must not be force-upgraded in development.
          upgradeInsecureRequests: config.isProd ? [] : null,
        },
      },
      hsts: config.isProd,
    })
  );

  app.use(express.json({ limit: '10kb' }));
  app.use(cookieParser());
  app.use(mongoSanitize());

  // Login: only failed attempts count, so normal use never locks anyone out
  // but password guessing is throttled. Registration counts every attempt.
  const authLimiter = (skipSuccessfulRequests) =>
    rateLimit({
      windowMs: 15 * 60 * 1000,
      max: authRateLimitMax,
      standardHeaders: true,
      legacyHeaders: false,
      skipSuccessfulRequests,
      message: { success: false, message: 'Too many attempts. Please try again later.' },
    });

  const makeLimiter = (max, message) =>
    rateLimit({
      windowMs: 15 * 60 * 1000,
      max,
      standardHeaders: true,
      legacyHeaders: false,
      message: { success: false, message },
    });

  app.use('/api', makeLimiter(apiRateLimitMax, 'Too many requests. Please slow down.'));
  app.use('/api', csrf);
  // Uploads are the most expensive endpoint, so they get their own stricter limit.
  app.post('/api/requests/:id/document', makeLimiter(uploadRateLimitMax, 'Too many uploads. Please try again later.'));
  app.use('/api/auth/login', authLimiter(true));
  app.use('/api/auth/register', authLimiter(false));
  app.use('/api/auth', authRoutes);
  app.use('/api/admin', adminRoutes);
  app.use('/api/requests', requestRoutes);
  app.use('/api', notFound);

  app.use(express.static(path.join(__dirname, '..', 'client')));

  // Unknown pages get a friendly HTML 404; anything else gets the JSON 404.
  app.use((req, res, next) => {
    if (req.method === 'GET' && req.accepts(['html', 'json']) === 'html') {
      return res.status(404).sendFile(path.join(__dirname, '..', 'client', '404.html'));
    }
    return notFound(req, res, next);
  });
  app.use(errorHandler);
  return app;
}

module.exports = createApp;
