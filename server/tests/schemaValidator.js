'use strict';

// A small JSON-schema checker for the subset of OpenAPI 3.0 that server/openapi.js uses:
// $ref, allOf, type, nullable, enum, required, properties, additionalProperties, items, format
// (date, date-time), minimum, maximum, maxLength. It exists so the contract tests can compare REAL
// responses with the published description without a dependency. Unknown keywords are ignored, so
// it only ever checks what it understands.
function resolve(ref, spec) {
  const parts = ref.replace(/^#\//, '').split('/');
  return parts.reduce((o, k) => (o === undefined ? o : o[k]), spec);
}

const DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

function validate(schema, value, spec, path = '$') {
  const errors = [];
  if (!schema) return errors;
  if (schema.$ref) {
    const target = resolve(schema.$ref, spec);
    if (!target) return [`${path}: unresolved reference ${schema.$ref}`];
    return validate(target, value, spec, path);
  }
  if (schema.allOf) for (const s of schema.allOf) errors.push(...validate(s, value, spec, path));
  if (value === null) {
    if (schema.nullable) return errors;
    if (schema.type) return [...errors, `${path}: null is not allowed`];
    return errors;
  }
  if (schema.enum && !schema.enum.includes(value)) errors.push(`${path}: ${JSON.stringify(value)} is not one of ${JSON.stringify(schema.enum)}`);

  switch (schema.type) {
    case 'string':
      if (typeof value !== 'string') errors.push(`${path}: expected string, got ${typeof value}`);
      else {
        if (schema.format === 'date-time' && !(DATE_TIME.test(value) && !Number.isNaN(Date.parse(value)))) errors.push(`${path}: "${value}" is not a date-time`);
        if (schema.format === 'date' && !DATE.test(value)) errors.push(`${path}: "${value}" is not a date`);
        if (schema.maxLength !== undefined && value.length > schema.maxLength) errors.push(`${path}: longer than ${schema.maxLength}`);
      }
      break;
    case 'integer':
    case 'number':
      if (typeof value !== 'number' || Number.isNaN(value)) errors.push(`${path}: expected ${schema.type}, got ${typeof value}`);
      else {
        if (schema.type === 'integer' && !Number.isInteger(value)) errors.push(`${path}: ${value} is not an integer`);
        if (schema.minimum !== undefined && value < schema.minimum) errors.push(`${path}: below ${schema.minimum}`);
        if (schema.maximum !== undefined && value > schema.maximum) errors.push(`${path}: above ${schema.maximum}`);
      }
      break;
    case 'boolean':
      if (typeof value !== 'boolean') errors.push(`${path}: expected boolean, got ${typeof value}`);
      break;
    case 'array':
      if (!Array.isArray(value)) errors.push(`${path}: expected array`);
      else if (schema.items) value.forEach((v, i) => errors.push(...validate(schema.items, v, spec, `${path}[${i}]`)));
      break;
    case 'object':
      if (typeof value !== 'object' || Array.isArray(value)) errors.push(`${path}: expected object`);
      else {
        for (const key of schema.required || []) if (!(key in value)) errors.push(`${path}: missing required "${key}"`);
        const props = schema.properties || {};
        for (const [k, v] of Object.entries(value)) {
          if (props[k]) errors.push(...validate(props[k], v, spec, `${path}.${k}`));
          else if (schema.additionalProperties === false) errors.push(`${path}: unexpected field "${k}"`);
          else if (schema.additionalProperties && typeof schema.additionalProperties === 'object') errors.push(...validate(schema.additionalProperties, v, spec, `${path}.${k}`));
        }
      }
      break;
    default:
      break;
  }
  return errors;
}

// The response schema for an operation and status code.
const responseSchema = (spec, pathKey, status, method = 'get') => {
  const r = spec.paths[pathKey][method].responses[status];
  return r && r.content && r.content['application/json'] ? r.content['application/json'].schema : undefined;
};

module.exports = { validate, responseSchema, resolve };
