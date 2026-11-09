'use strict';

// One-time bootstrap: creates the first Admin from environment variables.
// Never logs the password. Remove/rotate INITIAL_ADMIN_PASSWORD afterwards.
require('dotenv').config({ quiet: true });
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const User = require('../server/models/User');
const { ROLES } = require('../server/config/constants');

async function seed() {
  const email = (process.env.INITIAL_ADMIN_EMAIL || '').trim().toLowerCase();
  const password = process.env.INITIAL_ADMIN_PASSWORD || '';
  const name = process.env.INITIAL_ADMIN_NAME || 'System Admin';
  const uri = process.env.MONGODB_URI;

  if (!uri) throw new Error('MONGODB_URI is not set');
  if (!email || !password) {
    throw new Error('INITIAL_ADMIN_EMAIL and INITIAL_ADMIN_PASSWORD must be set');
  }
  if (password.length < 8 || password === 'change_this_securely') {
    throw new Error('INITIAL_ADMIN_PASSWORD is too weak or still the example value');
  }

  await mongoose.connect(uri);
  try {
    const existing = await User.findOne({ email });
    if (existing) {
      console.log('Admin already exists. Nothing to do.');
      return;
    }
    const passwordHash = await bcrypt.hash(password, 12);
    await User.create({ name, email, passwordHash, role: ROLES.ADMIN, department: null });
    console.log(`Admin account created for ${email}. Now remove INITIAL_ADMIN_PASSWORD from the environment.`);
  } finally {
    await mongoose.disconnect();
  }
}

seed().catch((err) => {
  console.error('Seed failed:', err.message);
  process.exit(1);
});
