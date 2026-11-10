'use strict';

// CSV for spreadsheets. Two safety rules:
//  1. Quote every field (RFC 4180): commas, quotes and line breaks cannot break the row.
//  2. Spreadsheet formula injection: a cell that starts with = + - @ (or a tab/CR) would be run as a
//     formula by Excel, Sheets or LibreOffice. Such cells get a leading apostrophe, so data that a
//     user typed (a name, a purpose) can never execute when an Admin opens the export.
const FORMULA_START = /^[=+\-@\t\r]/;

function cell(value) {
  if (value === null || value === undefined) return '""';
  let s = value instanceof Date ? value.toISOString() : typeof value === 'object' ? JSON.stringify(value) : String(value);
  if (FORMULA_START.test(s)) s = `'${s}`;
  return `"${s.replace(/"/g, '""')}"`;
}

const line = (values) => values.map(cell).join(',');

function toCsv(header, rows) {
  return [line(header), ...rows.map(line)].join('\r\n') + '\r\n';
}

// Sends a CSV as a download. Never cached; never sniffed.
function sendCsv(res, filename, header, rows) {
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${filename.replace(/[^A-Za-z0-9._-]/g, '_')}"`);
  res.setHeader('Cache-Control', 'private, no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.status(200).send(toCsv(header, rows));
}

const MAX_EXPORT_ROWS = 5000;

module.exports = { toCsv, sendCsv, cell, MAX_EXPORT_ROWS };
