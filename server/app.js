'use strict';

const path = require('path');
const express = require('express');
const helmet = require('helmet');
const cookieParser = require('cookie-parser');
const mongoSanitize = require('express-mongo-sanitize');
const rateLimit = require('express-rate-limit');
const mongoose = require('mongoose');
const Heartbeat = require('./models/Heartbeat');
const requestLog = require('./middleware/requestLog');

const config = require('./config/env');
const csrf = require('./middleware/csrf');
const { notFound, errorHandler } = require('./middleware/errorHandler');
const authRoutes = require('./routes/authRoutes');
const adminRoutes = require('./routes/adminRoutes');
const requestRoutes = require('./routes/requestRoutes');
const platformRoutes = require('./routes/platformRoutes');
const metaRoutes = require('./routes/metaRoutes');
const verifyRoutes = require('./routes/verifyRoutes');
const notificationRoutes = require('./routes/notificationRoutes');
const brandingRoutes = require('./routes/brandingRoutes');
const analyticsRoutes = require('./routes/analyticsRoutes');
const createApiV1Router = require('./routes/apiV1Routes');
const resolveTenant = require('./middleware/resolveTenant');
const { SLUG_PATTERN } = require('./models/Tenant');

function createApp({
  authRateLimitMax = 20,
  uploadRateLimitMax = 30,
  apiRateLimitMax = config.generalRateLimitMax,
  trustProxy = config.trustProxy,
  apiKeyRateLimitMax = config.apiRateLimitMax,
} = {}) {
  const app = express();
  app.disable('x-powered-by');
  // Behind a reverse proxy (Render) every request arrives from the proxy's address.
  // Trusting exactly N hops makes req.ip the real client, so per-IP rate limits work
  // and one noisy client cannot lock everyone else out.
  if (trustProxy) app.set('trust proxy', trustProxy);

  // Liveness/readiness probe for the host (Render health check). Public on purpose,
  // exposes no data and is not rate limited, so monitoring never trips a limit.
  app.use(requestLog);
  app.get('/healthz', (_req, res) => {
    const connected = mongoose.connection.readyState === 1;
    res.set('Cache-Control', 'no-store');
    res.status(connected ? 200 : 503).json({ status: connected ? 'ok' : 'unavailable' });
  });

  // Readiness: the database answers and, where a separate worker is expected, it has reported recently.
  // Public, no data: only ok/unavailable and booleans. WORKER_MAX_AGE_SECONDS=0 turns the worker check off.
  app.get('/readyz', async (_req, res) => {
    res.set('Cache-Control', 'no-store');
    const checks = { database: mongoose.connection.readyState === 1 };
    if (checks.database && config.workerMaxAgeSeconds > 0) {
      const beat = await Heartbeat.findOne({ name: 'worker' }).lean().catch(() => null);
      checks.worker = Boolean(beat && Date.now() - new Date(beat.at).getTime() <= config.workerMaxAgeSeconds * 1000);
    }
    const ready = Object.values(checks).every(Boolean);
    res.status(ready ? 200 : 503).json({ status: ready ? 'ok' : 'unavailable', checks });
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

  // API answers are per-person: shared caches and the back button must not keep them. A route that is
  // genuinely public and cacheable (branding) sets its own header afterwards.
  app.use('/api', (_req, res, next) => {
    res.set('Cache-Control', 'no-store');
    next();
  });
  app.use('/api', makeLimiter(apiRateLimitMax, 'Too many requests. Please slow down.'));
  app.use('/api', csrf);

  // Platform level: institution signup and SUPER_ADMIN (no tenant in the path).
  app.use('/api/platform/signup', authLimiter(false));
  app.use('/api/platform/auth/login', authLimiter(true));
  app.use('/api/platform', platformRoutes);

  // Everything institution-specific lives under /api/t/:slug. resolveTenant runs first and
  // opens the tenant context, so no route below can run without a tenant.
  const tenantApi = express.Router({ mergeParams: true });
  tenantApi.use(resolveTenant);
  // Uploads are the most expensive endpoint, so they get their own stricter limit.
  tenantApi.post(
    ['/requests/:id/document', '/requests/:id/documents', '/requests/:id/documents/:docId/replace'],
    makeLimiter(uploadRateLimitMax, 'Too many uploads. Please try again later.')
  );
  // Public document verification: no sign-in, so it gets its own limiter.
  tenantApi.use('/verify', makeLimiter(60, 'Too many verification attempts. Please try again later.'));
  tenantApi.use('/verify', verifyRoutes);
  tenantApi.use('/auth/login', authLimiter(true));
  tenantApi.use('/auth/register', authLimiter(false));
  // Token endpoints get the same throttle (tokens are 256-bit, but there is no reason to allow guessing).
  tenantApi.use(
    ['/auth/forgot-password', '/auth/reset-password', '/auth/verify-email', '/auth/resend-verification', '/auth/invite', '/auth/accept-invite'],
    authLimiter(false)
  );
  tenantApi.use('/auth', authRoutes);
  tenantApi.use('/meta', metaRoutes);
  tenantApi.use('/notifications', notificationRoutes);
  tenantApi.use('/branding', brandingRoutes);
  tenantApi.use('/analytics', analyticsRoutes);
  tenantApi.use('/v1', createApiV1Router({ max: apiKeyRateLimitMax }));
  tenantApi.use('/admin', adminRoutes);
  tenantApi.use('/requests', requestRoutes);
  app.use('/api/t/:slug', tenantApi);
  app.use('/api', notFound);

  const clientDir = path.join(__dirname, '..', 'client');
  // The same static client is served under each institution's address; its pages read the
  // slug from the URL. Malformed slugs fall through to the 404 page.
  const validSlug = (req, _res, next) => (SLUG_PATTERN.test(req.params.slug) ? next() : next('router'));
  // The institution's own home page is home.html; the bare /t/<slug> redirects so relative links work.
  app.get('/t/:slug', validSlug, (req, res) => {
    if (!req.path.endsWith('/')) return res.redirect(302, `/t/${req.params.slug}/`);
    return res.sendFile(path.join(clientDir, 'home.html'));
  });
  app.use('/t/:slug', validSlug, express.static(clientDir, { index: 'index.html' }));
  app.use(express.static(clientDir));

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
