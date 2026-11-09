'use strict';

// One-time bootstrap of the platform operator (SUPER_ADMIN). Institutions and their own
// Admins are created through signup (POST /api/platform/signup, needs SIGNUP_KEY).
// Never logs the password. Remove SUPER_ADMIN_PASSWORD from the environment afterwards.
require('dotenv').config({ quiet: true });
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const User = require('../server/models/User');
const { ROLES } = require('../server/config/constants');
const { runUnscoped } = require('../server/utils/tenantContext');

async function seed() {
  const email = (process.env.SUPER_ADMIN_EMAIL || '').trim().toLowerCase();
  const password = process.env.SUPER_ADMIN_PASSWORD || '';
  const name = process.env.SUPER_ADMIN_NAME || 'Platform Owner';
  const uri = process.env.MONGODB_URI;

  if (!uri) throw new Error('MONGODB_URI is not set');
  if (!email || !password) throw new Error('SUPER_ADMIN_EMAIL and SUPER_ADMIN_PASSWORD must be set');
  if (password.length < 12 || password === 'change_this_securely') {
    throw new Error('SUPER_ADMIN_PASSWORD must be at least 12 characters and not the example value');
  }

  await mongoose.connect(uri);
  try {
    await runUnscoped(async () => {
      if (await User.findOne({ email, role: ROLES.SUPER_ADMIN })) {
        console.log('Platform owner already exists. Nothing to do.');
        return;
      }
      const passwordHash = await bcrypt.hash(password, 12);
      await User.create({ name, email, passwordHash, role: ROLES.SUPER_ADMIN });
      console.log(`Platform owner created for ${email}. Now remove SUPER_ADMIN_PASSWORD from the environment.`);
    });
  } finally {
    await mongoose.disconnect();
  }
}

seed().catch((err) => {
  console.error('Seed failed:', err.message);
  process.exit(1);
});
