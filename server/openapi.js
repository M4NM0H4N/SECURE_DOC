'use strict';

// The OpenAPI 3.0 description of the integration API (v1) and of the webhook payloads. It is the
// contract: server/tests/contract.test.js validates REAL responses against these schemas, and
// docs/openapi.json is generated from it (npm run openapi), so the file cannot drift.
const { REQUEST_STATUSES } = require('./config/constants');

const dateTime = { type: 'string', format: 'date-time' };
const err = (description) => ({ description, content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } });
const ok = (description, schema) => ({ description, content: { 'application/json': { schema } } });
const envelope = (data) => ({ type: 'object', required: ['success', 'data'], additionalProperties: false, properties: { success: { type: 'boolean', enum: [true] }, data } });

const listParams = [
  { name: 'status', in: 'query', schema: { type: 'string', enum: Object.values(REQUEST_STATUSES) } },
  { name: 'department', in: 'query', schema: { type: 'string' }, description: 'Department code, for example CSE' },
  { name: 'documentType', in: 'query', schema: { type: 'string' } },
  { name: 'q', in: 'query', schema: { type: 'string', maxLength: 80 }, description: 'Case-insensitive search in the document type' },
  { name: 'from', in: 'query', schema: { type: 'string', format: 'date' } },
  { name: 'to', in: 'query', schema: { type: 'string', format: 'date' } },
  { name: 'sort', in: 'query', schema: { type: 'string', enum: ['createdAt', 'updatedAt', 'status', 'documentType'] } },
  { name: 'order', in: 'query', schema: { type: 'string', enum: ['asc', 'desc'] } },
  { name: 'page', in: 'query', schema: { type: 'integer', minimum: 1 } },
  { name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 100 } },
];

const REQUEST_PROPS = {
  id: { type: 'string' }, documentType: { type: 'string' }, department: { type: 'string' },
  status: { type: 'string', enum: Object.values(REQUEST_STATUSES) }, currentStep: { type: 'string', nullable: true },
  createdAt: dateTime, updatedAt: dateTime, fulfilledAt: { ...dateTime, nullable: true },
};
const REQUEST_REQUIRED = ['id', 'documentType', 'department', 'status', 'currentStep', 'createdAt', 'updatedAt', 'fulfilledAt'];

function buildSpec() {
  const counts = { type: 'object', additionalProperties: { type: 'integer' } };
  return {
    openapi: '3.0.3',
    info: {
      title: 'DocFlow integration API',
      version: '1.0.0',
      description:
        'Read-only access to one institution\'s document requests, for its own integrations. Authenticate with an API key created by the institution\'s Admin: `Authorization: Bearer dfk_...`. The API never returns names, purposes, staff identities, notes or documents. ' +
        'Outgoing webhooks are described under `x-webhooks`; verify their `X-DocFlow-Signature` header (HMAC-SHA256 of `<t>.<body>` with your webhook secret).',
    },
    servers: [{ url: '/api/t/{slug}', variables: { slug: { default: 'your-institution', description: 'The institution address' } } }],
    security: [{ apiKey: [] }],
    paths: {
      '/v1/requests': {
        get: {
          summary: 'List requests', operationId: 'listRequests', parameters: listParams,
          responses: {
            200: ok('A page of requests', envelope({ type: 'object', required: ['items', 'total', 'page', 'limit'], additionalProperties: false, properties: { items: { type: 'array', items: { $ref: '#/components/schemas/Request' } }, total: { type: 'integer' }, page: { type: 'integer' }, limit: { type: 'integer' } } })),
            400: err('Invalid parameters'), 401: err('Missing or invalid API key'), 403: err('The key lacks the requests:read scope'), 429: err('Rate limit reached'),
          },
        },
      },
      '/v1/requests/{id}': {
        get: {
          summary: 'Get one request with its status history', operationId: 'getRequest',
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
          responses: {
            200: ok('The request', envelope({ type: 'object', required: ['request'], additionalProperties: false, properties: { request: { $ref: '#/components/schemas/RequestDetail' } } })),
            400: err('Invalid id'), 401: err('Missing or invalid API key'), 403: err('The key lacks the requests:read scope'), 404: err('No such request in this institution'),
          },
        },
      },
      '/v1/analytics/summary': {
        get: {
          summary: 'Aggregate numbers for a period', operationId: 'analyticsSummary',
          parameters: [{ name: 'from', in: 'query', schema: { type: 'string', format: 'date' } }, { name: 'to', in: 'query', schema: { type: 'string', format: 'date' } }],
          responses: { 200: ok('Summary', envelope({ $ref: '#/components/schemas/AnalyticsSummary' })), 400: err('Invalid parameters'), 401: err('Missing or invalid API key'), 403: err('The key lacks the analytics:read scope') },
        },
      },
      '/v1/openapi.json': { get: { summary: 'This description', security: [], operationId: 'openapi', responses: { 200: { description: 'OpenAPI document' } } } },
    },
    components: {
      securitySchemes: { apiKey: { type: 'http', scheme: 'bearer', description: 'dfk_<prefix>_<secret>' } },
      schemas: {
        Error: { type: 'object', required: ['success', 'message'], properties: { success: { type: 'boolean', enum: [false] }, message: { type: 'string' }, errors: { type: 'array', items: { type: 'object', properties: { field: { type: 'string' }, message: { type: 'string' } } } } } },
        Request: { type: 'object', additionalProperties: false, required: REQUEST_REQUIRED, properties: REQUEST_PROPS },
        // Written out in full (not allOf): additionalProperties:false does not combine with allOf.
        RequestDetail: {
          type: 'object', additionalProperties: false, required: [...REQUEST_REQUIRED, 'history'],
          properties: {
            ...REQUEST_PROPS,
            history: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['status', 'step', 'at'], properties: { status: { type: 'string', enum: Object.values(REQUEST_STATUSES) }, step: { type: 'string', nullable: true }, at: dateTime } } },
          },
        },
        AnalyticsSummary: {
          type: 'object', additionalProperties: false,
          required: ['period', 'total', 'byStatus', 'byDepartment', 'byDocumentType', 'byMonth', 'turnaround', 'backlog', 'openRequests', 'rejection', 'slaEscalations'],
          properties: {
            period: { type: 'object', required: ['from', 'to'], properties: { from: { type: 'string', nullable: true }, to: { type: 'string', nullable: true } } },
            total: { type: 'integer' }, byStatus: counts, byDepartment: counts, byDocumentType: counts,
            byMonth: { type: 'array', items: { type: 'object', required: ['month', 'count'], properties: { month: { type: 'string' }, count: { type: 'integer' } } } },
            turnaround: { type: 'object', required: ['fulfilled', 'averageHours', 'medianHours', 'p90Hours'], properties: { fulfilled: { type: 'integer' }, averageHours: { type: 'number', nullable: true }, medianHours: { type: 'number', nullable: true }, p90Hours: { type: 'number', nullable: true } } },
            backlog: { type: 'array', items: { type: 'object', required: ['step', 'count'], properties: { step: { type: 'string' }, count: { type: 'integer' } } } },
            openRequests: { type: 'integer' },
            rejection: { type: 'object', required: ['rejected', 'decided', 'rate'], properties: { rejected: { type: 'integer' }, decided: { type: 'integer' }, rate: { type: 'number', nullable: true } } },
            slaEscalations: { type: 'integer' },
          },
        },
        WebhookEvent: {
          type: 'object', additionalProperties: false, required: ['event', 'createdAt', 'data'],
          properties: {
            event: { type: 'string', enum: ['request.submitted', 'request.status_changed', 'document.issued', 'ping'] },
            createdAt: dateTime,
            data: { type: 'object', description: 'Ids, statuses and times only: requestId, documentType, department, status, previousStatus, step, documentId, version' },
          },
        },
      },
    },
    'x-webhooks': {
      deliveries: {
        description: 'POST with JSON body (WebhookEvent). Headers: X-DocFlow-Event, X-DocFlow-Delivery, X-DocFlow-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256 of "<t>.<raw body>">. Answer 2xx within 10 seconds; anything else is retried with backoff (8 attempts).',
        requestBody: { content: { 'application/json': { schema: { $ref: '#/components/schemas/WebhookEvent' } } } },
      },
    },
  };
}

module.exports = { buildSpec };
