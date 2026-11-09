'use strict';

const mongoose = require('mongoose');

async function connectDb(uri) {
  if (!uri) {
    throw new Error('MongoDB URI is not configured');
  }
  mongoose.set('strictQuery', true);
  await mongoose.connect(uri);
  return mongoose.connection;
}

async function disconnectDb() {
  await mongoose.disconnect();
}

module.exports = { connectDb, disconnectDb };
