'use strict';

// Writes docs/openapi.json from server/openapi.js (the contract). A test fails if the committed
// file differs, so it cannot go stale: run "npm run openapi" after changing the description.
const fs = require('fs');
const path = require('path');
const { buildSpec } = require('../server/openapi');

const out = path.join(__dirname, '..', 'docs', 'openapi.json');
fs.writeFileSync(out, `${JSON.stringify(buildSpec(), null, 2)}\n`);
console.log('Wrote docs/openapi.json');
