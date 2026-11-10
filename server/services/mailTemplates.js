'use strict';

// Plain, short e-mails: a subject, a text body and a simple HTML body. Every value is escaped for
// HTML and nothing is trusted. Links come from the caller (built from PUBLIC_URL); ordinary
// notification mails link to an in-app page and contain no secret.
const esc = (v) =>
  String(v === undefined || v === null ? '' : v)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

const ROLE_WORDS = { CLERK: 'Clerk', HOD: 'Head of Department', PRINCIPAL: 'Principal', ADMIN: 'Administrator' };
const inst = (d) => d.institution || 'your institution';

// Each template returns { subject, lines: [paragraphs], cta: [label, linkKey] | null }.
const TEMPLATES = {
  'staff-invite': (d) => ({
    subject: `You are invited to join ${inst(d)}`,
    lines: [`${d.name ? `Hello ${d.name}, ` : ''}you have been invited to ${inst(d)} as ${ROLE_WORDS[d.role] || 'staff'}.`, 'Use the link below to choose your own password. It works once and expires in 7 days.'],
    cta: ['Accept the invitation', 'link'],
  }),
  'password-reset': (d) => ({
    subject: 'Reset your password',
    lines: [`${d.name ? `Hello ${d.name}, ` : ''}we received a request to reset your password.`, 'The link works once and expires in one hour. If this was not you, you can ignore this message.'],
    cta: ['Choose a new password', 'link'],
  }),
  'verify-email': (d) => ({
    subject: 'Verify your e-mail address',
    lines: [`${d.name ? `Hello ${d.name}, ` : ''}please confirm this e-mail address for ${inst(d)}.`, 'The link works once and expires in 48 hours.'],
    cta: ['Verify my address', 'link'],
  }),
  'request-submitted': (d) => ({
    subject: `New request to review: ${d.documentType}`,
    lines: [`${d.studentName || 'A student'} submitted a request for a ${d.documentType}.`, `It is waiting for: ${d.stepLabel || 'your action'}.`],
    cta: ['Open the request', 'link'],
  }),
  'step-waiting': (d) => ({
    subject: `A request is waiting for you: ${d.documentType}`,
    lines: [`A ${d.documentType} request from ${d.studentName || 'a student'} has reached your step: ${d.stepLabel || ''}.`],
    cta: ['Open the request', 'link'],
  }),
  'request-resubmitted': (d) => ({
    subject: `Information received: ${d.documentType}`,
    lines: [`${d.studentName || 'The student'} answered your question on the ${d.documentType} request. It is waiting for: ${d.stepLabel || 'your action'}.`],
    cta: ['Open the request', 'link'],
  }),
  'request-approved': (d) => ({
    subject: `Your request was approved: ${d.documentType}`,
    lines: [`Your ${d.documentType} request was approved. The office will now prepare and upload the document.`],
    cta: ['View the request', 'link'],
  }),
  'request-approved-upload': (d) => ({
    subject: `Approved: upload the document for ${d.documentType}`,
    lines: [`The ${d.documentType} request from ${d.studentName || 'a student'} was approved and is waiting for the official document.`],
    cta: ['Open the request', 'link'],
  }),
  'request-rejected': (d) => ({
    subject: `Your request was not approved: ${d.documentType}`,
    lines: [`Your ${d.documentType} request was not approved.`, d.reason ? `Reason: ${d.reason}` : ''],
    cta: ['View the request', 'link'],
  }),
  'request-needs-info': (d) => ({
    subject: `More information needed: ${d.documentType}`,
    lines: [`The office needs more information about your ${d.documentType} request.`, d.note ? `They asked: ${d.note}` : ''],
    cta: ['Answer and resubmit', 'link'],
  }),
  'request-fulfilled': (d) => ({
    subject: `Your document is ready: ${d.documentType}`,
    lines: [`Your ${d.documentType} is ready. Sign in to download it.`],
    cta: ['Open the request', 'link'],
  }),
  'sla-reminder': (d) => ({
    subject: `Reminder: a request is due soon: ${d.documentType}`,
    lines: [`A ${d.documentType} request is waiting at your step (${d.stepLabel || ''}) and is nearing its deadline.`],
    cta: ['Open the request', 'link'],
  }),
  'sla-escalation': (d) => ({
    subject: `Overdue request: ${d.documentType}`,
    lines: [`A ${d.documentType} request has been waiting at the step "${d.stepLabel || ''}" longer than its deadline.`, 'It needs attention.'],
    cta: ['Open the request', 'link'],
  }),
};

function render(template, data = {}) {
  const make = TEMPLATES[template];
  if (!make) throw new Error(`Unknown mail template: ${template}`);
  const t = make(data);
  const lines = t.lines.filter(Boolean);
  const url = t.cta ? data[t.cta[1]] : null;
  const text = [...lines, url ? `${t.cta[0]}: ${url}` : '', `-- ${inst(data)} (DocFlow)`].filter(Boolean).join('\n\n');
  const html =
    `<!doctype html><html><body style="font-family:system-ui,sans-serif;line-height:1.5;color:#111">` +
    lines.map((l) => `<p>${esc(l)}</p>`).join('') +
    (url ? `<p><a href="${esc(url)}">${esc(t.cta[0])}</a></p>` : '') +
    `<p style="color:#666;font-size:12px">${esc(inst(data))} (DocFlow)</p></body></html>`;
  return { subject: t.subject, text, html };
}

module.exports = { render, esc, TEMPLATE_NAMES: Object.keys(TEMPLATES) };
