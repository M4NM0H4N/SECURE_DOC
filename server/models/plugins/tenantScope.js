'use strict';

// Mongoose plugin: gives a schema a tenantId and injects it into every query, create and
// aggregate, so a forgotten filter cannot leak another institution's data.
//
// Limits (by design, documented in docs/TENANCY.md): raw driver access through
// Model.collection.* bypasses it, and so does runUnscoped(), which is reserved for platform
// code. insertMany and bulkWrite are refused in tenant mode rather than half-protected.
const mongoose = require('mongoose');
const { currentScope } = require('../../utils/tenantContext');

const QUERY_OPS = [
  'find',
  'findOne',
  'countDocuments',
  'distinct',
  'findOneAndUpdate',
  'findOneAndDelete',
  'findOneAndReplace',
  'updateOne',
  'updateMany',
  'replaceOne',
  'deleteOne',
  'deleteMany',
];
const UPDATE_OPS = ['findOneAndUpdate', 'updateOne', 'updateMany', 'replaceOne', 'findOneAndReplace'];

function touchesTenantId(update) {
  if (!update || typeof update !== 'object') return false;
  if ('tenantId' in update) return true;
  return Object.values(update).some((v) => v && typeof v === 'object' && !Array.isArray(v) && 'tenantId' in v);
}

function tenantScope(schema, { required = true } = {}) {
  schema.add({
    tenantId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Tenant',
      default: null,
      index: true,
      required,
    },
  });

  schema.pre(QUERY_OPS, function scopeQuery() {
    const scope = currentScope(this.model.modelName);
    if (scope.unscoped) return;
    if (UPDATE_OPS.includes(this.op) && touchesTenantId(this.getUpdate())) {
      throw new Error('tenantId cannot be changed');
    }
    // Overrides any tenantId a caller put in the filter.
    this.setQuery({ ...this.getQuery(), tenantId: scope.tenantId });
  });

  schema.pre('aggregate', function scopeAggregate() {
    const scope = currentScope(this.model().modelName);
    if (scope.unscoped) return;
    this.pipeline().unshift({ $match: { tenantId: scope.tenantId } });
  });

  schema.pre('validate', function stampTenant() {
    if (!this.isNew) return;
    const scope = currentScope(this.constructor.modelName);
    if (scope.unscoped) return;
    if (this.tenantId && String(this.tenantId) !== String(scope.tenantId)) {
      throw new Error('Cannot create a record for another tenant');
    }
    this.tenantId = scope.tenantId;
  });

  schema.pre(['insertMany', 'bulkWrite'], function refuseBulk() {
    const modelName = (this && this.modelName) || 'model';
    if (!currentScope(modelName).unscoped) {
      throw new Error('insertMany and bulkWrite are not allowed in tenant mode');
    }
  });
}

module.exports = tenantScope;
