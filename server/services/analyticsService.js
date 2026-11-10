'use strict';

const Request = require('../models/Request');
const Notification = require('../models/Notification');
const workflowService = require('./workflowService');
const { REQUEST_STATUSES: S } = require('../config/constants');
const { dateRange } = require('../utils/listQuery');

const OPEN = [S.PENDING, S.UNDER_REVIEW, S.NEEDS_INFO, S.APPROVED];
const HOUR = 3600 * 1000;

function percentile(sorted, p) {
  if (!sorted.length) return null;
  const i = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[i];
}
const round1 = (n) => (n === null ? null : Math.round(n * 10) / 10);
const count = (rows) => Object.fromEntries(rows.map((r) => [r._id === null ? 'unknown' : r._id, r.n]));

/**
 * One institution's numbers for a period (requests created between `from` and `to`; everything
 * in the report is scoped to the signed-in institution by the tenant layer). Counts and times only:
 * no names, no purposes, no documents.
 */
async function summary({ from, to } = {}) {
  const range = dateRange('createdAt', from, to) || {};
  const group = (field) => Request.aggregate([{ $match: range }, { $group: { _id: `$${field}`, n: { $sum: 1 } } }, { $sort: { n: -1, _id: 1 } }]);

  const [byStatus, byDepartment, byDocumentType, byMonth, total] = await Promise.all([
    group('status'),
    group('department'),
    group('documentType'),
    Request.aggregate([{ $match: range }, { $group: { _id: { $dateToString: { format: '%Y-%m', date: '$createdAt' } }, n: { $sum: 1 } } }, { $sort: { _id: 1 } }]),
    Request.countDocuments(range),
  ]);
  const status = count(byStatus);

  // Turnaround: submitted -> fulfilled, for requests fulfilled in the period's cohort (capped).
  const done = await Request.find({ ...range, status: S.FULFILLED }, 'createdAt statusHistory').sort({ createdAt: -1 }).limit(20000).lean();
  const hours = done
    .map((r) => {
      const entry = [...r.statusHistory].reverse().find((h) => h.to === S.FULFILLED);
      return entry ? (new Date(entry.at).getTime() - new Date(r.createdAt).getTime()) / HOUR : null;
    })
    .filter((h) => h !== null && h >= 0)
    .sort((a, b) => a - b);

  // Backlog: where open requests are waiting right now (independent of the period).
  const open = await Request.aggregate([
    { $match: { status: { $in: OPEN } } },
    { $group: { _id: { d: '$workflowDefinitionId', i: '$currentStepIndex', s: '$status' }, n: { $sum: 1 } } },
  ]);
  const defs = await workflowService.getMap(open.map((o) => o._id.d));
  const backlogMap = new Map();
  for (const o of open) {
    const def = defs.get(String(o._id.d));
    let step;
    if (o._id.s === S.APPROVED) step = 'Awaiting document upload';
    else if (o._id.s === S.NEEDS_INFO) step = 'Waiting for the student';
    else step = def && def.steps[o._id.i] ? def.steps[o._id.i].label : `Step ${o._id.i + 1}`;
    backlogMap.set(step, (backlogMap.get(step) || 0) + o.n);
  }
  const backlog = [...backlogMap.entries()].map(([step, n]) => ({ step, count: n })).sort((a, b) => b.count - a.count || a.step.localeCompare(b.step));

  const rejected = status[S.REJECTED] || 0;
  const decided = rejected + (status[S.APPROVED] || 0) + (status[S.FULFILLED] || 0);
  const escalations = await Notification.countDocuments({ channel: 'IN_APP', type: 'SLA_ESCALATION', ...(dateRange('createdAt', from, to) || {}) });

  return {
    period: { from: from ? new Date(from).toISOString() : null, to: to ? new Date(to).toISOString() : null },
    total,
    byStatus: status,
    byDepartment: count(byDepartment),
    byDocumentType: count(byDocumentType),
    byMonth: byMonth.map((m) => ({ month: m._id, count: m.n })),
    turnaround: {
      fulfilled: hours.length,
      averageHours: round1(hours.length ? hours.reduce((a, b) => a + b, 0) / hours.length : null),
      medianHours: round1(percentile(hours, 50)),
      p90Hours: round1(percentile(hours, 90)),
    },
    backlog,
    openRequests: backlog.reduce((n, b) => n + b.count, 0),
    rejection: { rejected, decided, rate: decided ? Math.round((rejected / decided) * 1000) / 1000 : null },
    slaEscalations: escalations,
  };
}

// A flat metric,value table for spreadsheets and accreditation paperwork.
function summaryRows(s) {
  const rows = [
    ['Period from', s.period.from || 'all time'], ['Period to', s.period.to || 'now'],
    ['Requests submitted', s.total], ['Requests still open', s.openRequests],
    ['Fulfilled requests measured', s.turnaround.fulfilled], ['Average turnaround (hours)', s.turnaround.averageHours ?? ''],
    ['Median turnaround (hours)', s.turnaround.medianHours ?? ''], ['90th percentile turnaround (hours)', s.turnaround.p90Hours ?? ''],
    ['Rejected', s.rejection.rejected], ['Decided (rejected, approved or fulfilled)', s.rejection.decided], ['Rejection rate', s.rejection.rate ?? ''],
    ['Deadline escalations', s.slaEscalations],
  ];
  for (const [k, v] of Object.entries(s.byStatus)) rows.push([`Status: ${k}`, v]);
  for (const [k, v] of Object.entries(s.byDepartment)) rows.push([`Department: ${k}`, v]);
  for (const [k, v] of Object.entries(s.byDocumentType)) rows.push([`Document type: ${k}`, v]);
  for (const m of s.byMonth) rows.push([`Month: ${m.month}`, m.count]);
  for (const b of s.backlog) rows.push([`Waiting at: ${b.step}`, b.count]);
  return rows;
}

module.exports = { summary, summaryRows };
