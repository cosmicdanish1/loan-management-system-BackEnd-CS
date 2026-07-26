/**
 * Generates a polished PDF API manual from the backend OpenAPI spec, using
 * pdfkit (already a backend dependency). Design mirrors the DOCX manual:
 * cover, conventions, per-module sections, per-endpoint entries with method
 * badges, impact callouts, params, request-body sample, curl + response.
 */
const fs = require('fs');
const path = require('path');
const PDFDocument = require('pdfkit');

const DOCS_DIR = path.join(__dirname, '..', '..', 'docs', 'api');
const OPENAPI = process.argv[2] || path.join(DOCS_DIR, 'openapi.json');
const OUT = process.argv[3] || path.join(DOCS_DIR, 'API_DOCUMENTATION.pdf');
const API_PREFIX = 'api/v1';
const PORT = '3001';
const SERVER = `http://<server-ip>:${PORT}`;
const spec = JSON.parse(fs.readFileSync(OPENAPI, 'utf8'));

const C = {
  navy: '#1F2A44', teal: '#0E7C86', gray: '#5A6472', hair: '#D9DEE4',
  codeBg: '#F4F6F8', text: '#2A3340',
  get: '#1B7F4B', post: '#1F5FBF', put: '#B7791F', patch: '#7A5AB5', delete: '#C0392B',
  readBg: '#E7F4EC', writeBg: '#FEF3E0', delBg: '#FCE8E6', infoBg: '#E8F0FE',
};
const methodColor = (m) => C[m] || C.navy;

// ---- schema sampling -----------------------------------------------------
const resolveRef = (ref) => (spec.components && spec.components.schemas && spec.components.schemas[ref.replace('#/components/schemas/', '')]) || {};
function sample(schema, depth = 0) {
  if (!schema || depth > 4) return null;
  if (schema.$ref) return sample(resolveRef(schema.$ref), depth + 1);
  if (schema.example !== undefined) return schema.example;
  if (Array.isArray(schema.enum) && schema.enum.length) return schema.enum[0];
  switch (schema.type) {
    case 'string':
      if (schema.format === 'date-time') return '2026-07-25T10:00:00.000Z';
      if (schema.format === 'date') return '2026-07-25';
      return 'string';
    case 'number': case 'integer': return 0;
    case 'boolean': return true;
    case 'array': { const v = sample(schema.items || {}, depth + 1); return v === null ? [] : [v]; }
    default: {
      const props = schema.properties; if (!props) return {};
      const o = {}; for (const [k, v] of Object.entries(props)) o[k] = sample(v, depth + 1); return o;
    }
  }
}

const METHODS = ['get', 'post', 'put', 'patch', 'delete'];
const allOps = [];
for (const [p, item] of Object.entries(spec.paths || {})) {
  for (const m of METHODS) { const op = item[m]; if (!op) continue; allOps.push({ method: m, path: p, tag: (op.tags && op.tags[0]) || p.split('/')[1] || 'default', op }); }
}
const byTag = new Map();
for (const o of allOps) { if (!byTag.has(o.tag)) byTag.set(o.tag, []); byTag.get(o.tag).push(o); }
const tags = [...byTag.keys()].sort((a, b) => a.localeCompare(b));

function impact(method, p) {
  if (/\/backup\/restore/.test(p)) return { bg: C.delBg, label: 'CRITICAL', text: 'Overwrites the ENTIRE database with a backup. Irreversible except via the auto pre-restore safety backup. Recovery use only.' };
  switch (method) {
    case 'get': return { bg: C.readBg, label: 'READ-ONLY', text: 'Safe. Returns data only; does not change anything on the server.' };
    case 'delete': return { bg: C.delBg, label: 'DELETES DATA', text: 'Removes the target record. Generally irreversible — confirm the id before calling.' };
    case 'put': case 'patch': return { bg: C.writeBg, label: 'UPDATES DATA', text: 'Modifies an existing record. Sending a field overwrites its stored value.' };
    case 'post': return { bg: C.writeBg, label: 'WRITES / ACTION', text: 'Creates a record or performs an action. Modifies data or triggers processing.' };
    default: return { bg: C.infoBg, label: 'INFO', text: '' };
  }
}
function authText(op) {
  const sec = op.security || spec.security;
  if (Array.isArray(sec) && sec.length && sec.some((s) => Object.keys(s).length)) return 'Bearer JWT required.';
  return 'No auth guard declared in the spec (verify before relying on it).';
}
function curlExample(method, p, op, bodySample) {
  const url = `${SERVER}/${API_PREFIX}${p}`;
  const needsAuth = authText(op).startsWith('Bearer');
  const parts = [`curl -X ${method.toUpperCase()} "${url}"`];
  const tail = [];
  if (needsAuth) tail.push('-H "Authorization: Bearer $TOKEN"');
  if (bodySample) { tail.push('-H "Content-Type: application/json"'); tail.push(`-d '${JSON.stringify(bodySample, null, 2)}'`); }
  if (!tail.length) return parts[0];
  return parts[0] + ' \\\n  ' + tail.join(' \\\n  ');
}
function responseExample(method) {
  return ['{', '  "success": true,', `  "statusCode": ${method === 'post' ? 201 : 200},`, '  "message": "Operation successful",',
    `  "data": ${method === 'get' ? '{ /* requested data */ }' : '{ /* affected record */ }'},`, '  "timestamp": "2026-07-25T10:00:00.000Z"', '}'].join('\n');
}
const BLURBS = {
  'Authentication': 'Login, logout, token refresh and current-user endpoints. Start here to obtain the Bearer token.',
  'User Management': 'Create, update and administer users, roles, permissions, sessions and audit trail.',
  'Members': 'Member master records: create, update, lookup, KYC documents, photos, signatures and lifecycle status.',
  'Loans': 'Loan application, sanction, disbursement, repayment, EMI schedules, sureties and month-end snapshots.',
  'Deposits': 'Fixed and recurring deposit accounts: creation, installments, closure and maturity.',
  'Reports': 'Read-only reporting endpoints (statements, registers, certificates) with optional PDF/Excel output.',
  'Database Backup': 'Create, list, validate, clean up and RESTORE encrypted database backups.',
  'System Configuration': 'Business rules, interest rates, deposit slabs and system settings.',
  'Role Management': 'User levels, default rights and menu permission mappings.',
};

// ---- pdfkit setup --------------------------------------------------------
const doc = new PDFDocument({ size: 'LETTER', margins: { top: 54, bottom: 60, left: 54, right: 54 }, bufferPages: true, autoFirstPage: false });
const stream = fs.createWriteStream(OUT);
doc.pipe(stream);
const M = doc.page ? doc.page.margins : { top: 54, bottom: 60, left: 54, right: 54 };
const PAGE_W = 612, PAGE_H = 792, LEFT = 54, RIGHT = 54, CW = PAGE_W - LEFT - RIGHT;
const bottom = () => PAGE_H - 60;
const outline = []; // {title, level, page}
let pageNo = 0;

doc.addPage(); pageNo = 1;

function ensure(h) { if (doc.y + h > bottom()) { doc.addPage(); pageNo++; } }
function moveDown(n) { doc.y += n; }

function para(text, { size = 10.5, color = C.text, font = 'Helvetica', gapAfter = 5, indent = 0, width = CW } = {}) {
  doc.font(font).fontSize(size).fillColor(color);
  const h = doc.heightOfString(text, { width: width - indent });
  ensure(h);
  doc.text(text, LEFT + indent, doc.y, { width: width - indent });
  moveDown(gapAfter);
}

function sectionLabel(text) {
  ensure(20);
  doc.font('Helvetica-Bold').fontSize(7.5).fillColor(C.teal).text(text.toUpperCase(), LEFT, doc.y, { characterSpacing: 1 });
  moveDown(3);
}

function codeBox(text) {
  const pad = 8, size = 8.5, lh = 1.25;
  doc.font('Courier').fontSize(size);
  const innerW = CW - pad * 2;
  const h = doc.heightOfString(text, { width: innerW, lineGap: size * (lh - 1) });
  const boxH = h + pad * 2;
  // Keep the whole box on one page when it can fit on a fresh page.
  if (doc.y + boxH > bottom()) { doc.addPage(); pageNo++; }
  const y0 = doc.y;
  doc.save();
  doc.roundedRect(LEFT, y0, CW, boxH, 4).fill(C.codeBg);
  doc.rect(LEFT, y0, 3, boxH).fill(C.teal);
  doc.restore();
  doc.font('Courier').fontSize(size).fillColor('#20303F').text(text, LEFT + pad, y0 + pad, { width: innerW, lineGap: size * (lh - 1) });
  doc.y = y0 + boxH;
  moveDown(7);
}

function calloutBox(imp, authStr) {
  const pad = 8, size = 9;
  const full = imp.text + '   Auth: ' + authStr;
  doc.font('Helvetica').fontSize(size);
  const innerW = CW - pad * 2 - 6;
  const labelW = doc.font('Helvetica-Bold').fontSize(size).widthOfString(imp.label + '  ');
  const textH = doc.font('Helvetica').fontSize(size).heightOfString(full, { width: innerW });
  const boxH = Math.max(textH + pad * 2, 22);
  ensure(boxH + 4);
  const y0 = doc.y;
  doc.save();
  doc.roundedRect(LEFT, y0, CW, boxH, 4).fill(imp.bg);
  doc.rect(LEFT, y0, 4, boxH).fill(C.navy);
  doc.restore();
  // label + text as one wrapped paragraph (label bold inline via continued)
  doc.font('Helvetica-Bold').fontSize(size).fillColor(C.navy).text(imp.label + '  ', LEFT + pad + 4, y0 + pad, { width: innerW, continued: true });
  doc.font('Helvetica').fontSize(size).fillColor(C.text).text(imp.text, { continued: true });
  doc.font('Helvetica-Oblique').fontSize(size - 0.5).fillColor(C.gray).text('   Auth: ' + authStr);
  doc.y = y0 + boxH;
  moveDown(7);
}

function paramsTable(params) {
  const cols = [120, 55, 60, CW - 235];
  const rowPad = 4;
  const drawHeaderRow = (y) => {
    doc.save().rect(LEFT, y, CW, 16).fill(C.navy).restore();
    doc.font('Helvetica-Bold').fontSize(8).fillColor('#FFFFFF');
    let x = LEFT + 4;
    ['Name', 'In', 'Required', 'Description'].forEach((t, i) => { doc.text(t, x, y + 4, { width: cols[i] - 6 }); x += cols[i]; });
    return y + 16;
  };
  ensure(30);
  let y = drawHeaderRow(doc.y);
  doc.font('Helvetica').fontSize(8.5);
  for (const pr of params) {
    const descH = doc.font('Helvetica').fontSize(8.5).heightOfString(pr.description || '—', { width: cols[3] - 6 });
    const rowH = Math.max(descH + rowPad * 2, 15);
    if (y + rowH > bottom()) { doc.addPage(); pageNo++; y = drawHeaderRow(M.top); }
    doc.save().rect(LEFT, y, CW, rowH).strokeColor(C.hair).lineWidth(0.5).stroke().restore();
    let x = LEFT + 4;
    doc.font('Courier').fontSize(8.5).fillColor('#20303F').text(pr.name, x, y + rowPad, { width: cols[0] - 6 }); x += cols[0];
    doc.font('Helvetica').fontSize(8.5).fillColor(C.text).text(pr.in, x, y + rowPad, { width: cols[1] - 6 }); x += cols[1];
    doc.text(pr.required ? 'yes' : 'no', x, y + rowPad, { width: cols[2] - 6 }); x += cols[2];
    doc.text(pr.description || '—', x, y + rowPad, { width: cols[3] - 6 });
    y += rowH;
  }
  doc.y = y; moveDown(7);
}

function hr() { ensure(10); doc.save().moveTo(LEFT, doc.y).lineTo(LEFT + CW, doc.y).lineWidth(0.5).strokeColor(C.hair).stroke().restore(); moveDown(8); }

function heading1(text) { doc.addPage(); pageNo++; outline.push({ title: text, level: 0, page: pageNo }); doc.font('Helvetica-Bold').fontSize(19).fillColor(C.navy).text(text, LEFT, doc.y); moveDown(3); }
function heading2Endpoint(method, p) {
  ensure(30);
  const y0 = doc.y;
  // method badge
  doc.font('Helvetica-Bold').fontSize(9);
  const mText = method.toUpperCase();
  const bw = doc.widthOfString(mText) + 12;
  doc.save().roundedRect(LEFT, y0, bw, 15, 3).fill(methodColor(method)).restore();
  doc.fillColor('#FFFFFF').text(mText, LEFT + 6, y0 + 3.5);
  // path
  doc.font('Courier-Bold').fontSize(11).fillColor(C.navy).text(p, LEFT + bw + 8, y0 + 2, { width: CW - bw - 8 });
  doc.y = Math.max(doc.y, y0 + 16);
  outline.push({ title: method.toUpperCase() + ' ' + p, level: 1, page: pageNo });
  moveDown(4);
}

// ---- COVER ---------------------------------------------------------------
doc.save().rect(0, 0, PAGE_W, 10).fill(C.teal).restore();
doc.y = 150;
doc.font('Helvetica-Bold').fontSize(13).fillColor(C.teal).text('PAPER WHITE TECHNOLOGY', LEFT, doc.y, { characterSpacing: 3 });
moveDown(10);
doc.font('Helvetica-Bold').fontSize(40).fillColor(C.navy).text('Loan Management System', LEFT, doc.y, { width: CW });
moveDown(4);
doc.font('Helvetica').fontSize(20).fillColor(C.gray).text('API Reference & Usage Manual', LEFT, doc.y);
moveDown(18);
doc.save().moveTo(LEFT, doc.y).lineTo(LEFT + CW, doc.y).lineWidth(1).strokeColor(C.hair).stroke().restore();
moveDown(16);
const coverRows = [
  ['Version', String(spec.info.version || '1.0')],
  ['Generated', new Date().toISOString().slice(0, 10)],
  ['Total endpoints', allOps.length + ' across ' + tags.length + ' modules'],
  ['Server root', SERVER],
  ['Global prefix', '/' + API_PREFIX + '  (already included in every path)'],
  ['Authentication', 'Bearer JWT — POST /' + API_PREFIX + '/auth/login'],
];
coverRows.forEach(([k, v]) => {
  const y = doc.y;
  doc.font('Helvetica-Bold').fontSize(11).fillColor(C.navy).text(k, LEFT, y, { width: 130 });
  doc.font('Helvetica').fontSize(11).fillColor(C.text).text(v, LEFT + 140, y, { width: CW - 140 });
  doc.y = Math.max(doc.y, y) + 8;
});

// ---- ABOUT ---------------------------------------------------------------
heading1('About this document');
moveDown(4);
para('This manual documents every HTTP endpoint exposed by the LMS backend. It is generated directly from the live OpenAPI specification, so it always matches the code.');
para('Each entry states what the endpoint does, its impact (whether it reads or changes data), the authentication it needs, its parameters, and a copy-paste working example with a sample response.');
sectionLabel('Base URL & prefix');
para('Every path already includes the /' + API_PREFIX + ' prefix. Prepend the server root, e.g. ' + SERVER + '/' + API_PREFIX + '/auth/login');
sectionLabel('Authentication flow');
para('1) POST /auth/login with username & password.  2) Copy accessToken from the response.  3) Send it as an Authorization: Bearer header on every other call.');
codeBox('# 1) Log in and capture the token\nTOKEN=$(curl -s -X POST "' + SERVER + '/' + API_PREFIX + '/auth/login" \\\n  -H "Content-Type: application/json" \\\n  -d \'{ "username": "admin", "password": "your-password" }\' | jq -r .data.accessToken)\n\n# 2) Use it on any endpoint\ncurl "' + SERVER + '/' + API_PREFIX + '/members" -H "Authorization: Bearer $TOKEN"');
sectionLabel('Standard response envelope');
para('Successful responses are wrapped in this envelope; the payload is in "data". Errors set success=false with an HTTP 4xx/5xx status and a message.');
codeBox('{\n  "success": true,\n  "statusCode": 200,\n  "message": "Operation successful",\n  "data": { /* endpoint payload */ },\n  "timestamp": "2026-07-25T10:00:00.000Z"\n}');
sectionLabel('Impact legend');
[['READ-ONLY', 'Safe. Returns data only.'], ['WRITES / ACTION', 'POST — creates a record or performs an action.'],
 ['UPDATES DATA', 'PUT / PATCH — modifies an existing record.'], ['DELETES DATA', 'DELETE — removes a record (usually irreversible).'],
 ['CRITICAL', 'Destructive, system-wide (e.g. database restore).']].forEach(([k, v]) => {
  ensure(14);
  const y = doc.y;
  doc.font('Helvetica-Bold').fontSize(9.5).fillColor(C.navy).text('• ' + k + '  ', LEFT + 4, y, { continued: true });
  doc.font('Helvetica').fontSize(9.5).fillColor(C.text).text('— ' + v);
  moveDown(3);
});

// ---- MODULES -------------------------------------------------------------
tags.forEach((tag) => {
  const list = byTag.get(tag).sort((a, b) => a.path.localeCompare(b.path) || a.method.localeCompare(b.method));
  heading1(tag);
  doc.font('Helvetica-Oblique').fontSize(9.5).fillColor(C.gray).text((BLURBS[tag] || 'Endpoints in the ' + tag + ' module.') + '  (' + list.length + ' endpoint' + (list.length > 1 ? 's' : '') + ')', LEFT, doc.y, { width: CW });
  moveDown(6);
  hr();
  list.forEach((o, idx) => {
    const { method, path: p, op } = o;
    heading2Endpoint(method, p);
    if (op.summary) para(op.summary, { size: 10.5 });
    if (op.description && op.description !== op.summary) para(op.description, { size: 9.5, color: C.gray });
    calloutBox(impact(method, p), authText(op));
    const params = (op.parameters || []).filter((x) => x.in === 'path' || x.in === 'query');
    if (params.length) { sectionLabel('Parameters'); paramsTable(params); }
    const js = op.requestBody && op.requestBody.content && op.requestBody.content['application/json'] && op.requestBody.content['application/json'].schema;
    const bodySample = js ? sample(js) : null;
    const hasBody = bodySample && Object.keys(bodySample).length;
    if (hasBody) { sectionLabel('Request body (JSON)'); codeBox(JSON.stringify(bodySample, null, 2)); }
    sectionLabel('Example request');
    codeBox(curlExample(method, p, op, hasBody ? bodySample : null));
    sectionLabel('Example response');
    codeBox(responseExample(method));
    if (idx < list.length - 1) hr();
  });
});

// ---- footers + outline ---------------------------------------------------
const range = doc.bufferedPageRange();
for (let i = range.start; i < range.start + range.count; i++) {
  doc.switchToPage(i);
  // Writing into the bottom margin makes pdfkit auto-append a page; zero the
  // bottom margin on this page so the footer text does not trigger pagination.
  doc.page.margins.bottom = 0;
  const n = i - range.start + 1;
  if (n === 1) continue; // no footer on cover
  doc.font('Helvetica').fontSize(8).fillColor(C.gray);
  doc.text('Paper White Technology — LMS API Manual', LEFT, PAGE_H - 42, { width: CW / 2, lineBreak: false });
  doc.text('Page ' + n + ' of ' + range.count, LEFT + CW / 2, PAGE_H - 42, { width: CW / 2, align: 'right', lineBreak: false });
}
// PDF outline (bookmarks)
const top = {};
for (const o of outline) {
  if (o.level === 0) { top.node = doc.outline.addItem(o.title); top.title = o.title; }
  else if (top.node) { top.node.addItem(o.title); }
}

doc.end();
stream.on('finish', () => {
  const sz = fs.statSync(OUT).size;
  console.log('Wrote ' + OUT + ' (' + (sz / 1024 / 1024).toFixed(2) + ' MB), ' + range.count + ' pages, ' + allOps.length + ' endpoints.');
});
