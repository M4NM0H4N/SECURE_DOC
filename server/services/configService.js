'use strict';

const Department = require('../models/Department');
const DocumentType = require('../models/DocumentType');
const AppError = require('../utils/AppError');
const { runInTransaction } = require('../config/transactions');
const audit = require('./auditService');

const opt = (session) => (session ? { session } : {});

// ---- Departments -------------------------------------------------------------------------
const listDepartments = ({ includeInactive = false } = {}) =>
  Department.find(includeInactive ? {} : { isActive: true }).sort({ code: 1 });

async function isActiveDepartment(code) {
  if (typeof code !== 'string') return false;
  return Boolean(await Department.exists({ code: code.trim().toUpperCase(), isActive: true }));
}

function createDepartment(actor, { code, name }) {
  return runInTransaction(async (session) => {
    const [dept] = await Department.create([{ code, name }], opt(session));
    await audit.record(
      { actorId: actor._id, action: 'DEPARTMENT_CREATED', details: { code: dept.code, name: dept.name } },
      { session }
    );
    return dept;
  });
}

// The code is immutable (users and requests refer to it). Name and active flag only.
function updateDepartment(actor, id, { name, isActive }) {
  return runInTransaction(async (session) => {
    const dept = await (session ? Department.findById(id).session(session) : Department.findById(id));
    if (!dept) throw new AppError(404, 'Department not found');
    if (name !== undefined) dept.name = name;
    if (isActive !== undefined) dept.isActive = isActive;
    await dept.save(opt(session));
    await audit.record(
      { actorId: actor._id, action: 'DEPARTMENT_UPDATED', details: { code: dept.code, name: dept.name, isActive: dept.isActive } },
      { session }
    );
    return dept;
  });
}

// ---- Document types ----------------------------------------------------------------------
const listDocumentTypes = ({ includeInactive = false } = {}) =>
  DocumentType.find(includeInactive ? {} : { isActive: true }).sort({ name: 1 });

// Returns the stored (canonical) name of an ACTIVE type, or null.
async function resolveActiveDocumentType(name) {
  if (typeof name !== 'string') return null;
  const type = await DocumentType.findOne({ nameKey: name.trim().toLowerCase(), isActive: true });
  return type ? type.name : null;
}

function createDocumentType(actor, { name }) {
  return runInTransaction(async (session) => {
    const [type] = await DocumentType.create([{ name }], opt(session));
    await audit.record({ actorId: actor._id, action: 'DOCUMENT_TYPE_CREATED', details: { name: type.name } }, { session });
    return type;
  });
}

function updateDocumentType(actor, id, { name, isActive }) {
  return runInTransaction(async (session) => {
    const type = await (session ? DocumentType.findById(id).session(session) : DocumentType.findById(id));
    if (!type) throw new AppError(404, 'Document type not found');
    // Renaming is allowed; existing requests keep the name they were submitted with.
    if (name !== undefined) type.name = name;
    if (isActive !== undefined) type.isActive = isActive;
    await type.save(opt(session));
    await audit.record(
      { actorId: actor._id, action: 'DOCUMENT_TYPE_UPDATED', details: { name: type.name, isActive: type.isActive } },
      { session }
    );
    return type;
  });
}

module.exports = {
  listDepartments, isActiveDepartment, createDepartment, updateDepartment,
  listDocumentTypes, resolveActiveDocumentType, createDocumentType, updateDocumentType,
};
