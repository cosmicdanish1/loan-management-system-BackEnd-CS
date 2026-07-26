/**
 * Generates a polished Word (.docx) API manual from the backend OpenAPI spec.
 * Every endpoint gets: description, impact, auth, params, a request-body sample,
 * a working curl example, and a sample response envelope.
 */
const fs = require('fs');
const path = require('path');
const {
  Document, Packer, Paragraph, TextRun, HeadingLevel, AlignmentType,
  Table, TableRow, TableCell, WidthType, BorderStyle, ShadingType,
  TableOfContents, PageBreak, PositionalTab, PositionalTabAlignment, PositionalTabLeader,
} = require('docx');

// -------- inputs / constants ---------------------------------------------
const DOCS_DIR = path.join(__dirname, '..', '..', 'docs', 'api');
const OPENAPI = process.argv[2] || path.join(DOCS_DIR, 'openapi.json');
const OUT = process.argv[3] || path.join(DOCS_DIR, 'API_DOCUMENTATION.docx');
const API_PREFIX = 'api/v1';
const PORT = '3001';
const SERVER = `http://<server-ip>:${PORT}`;
const doc_ = JSON.parse(fs.readFileSync(OPENAPI, 'utf8'));

const CONTENT_W = 10080; // Letter (12240) minus 2 x 1080 margins
const MONO = 'Consolas';
const BODY = 'Calibri';

const COLORS = {
  navy: '1F2A44', teal: '0E7C86', grayText: '5A6472', hair: 'D9DEE4',
  codeBg: 'F4F6F8', getC: '1B7F4B', postC: '1F5FBF', putC: 'B7791F',
  patchC: '7A5AB5', delC: 'C0392B',
  readBg: 'E7F4EC', writeBg: 'FEF3E0', delBg: 'FCE8E6', infoBg: 'E8F0FE',
};

const methodColor = (m) => ({ get: COLORS.getC, post: COLORS.postC, put: COLORS.putC, patch: COLORS.patchC, delete: COLORS.delC }[m] || COLORS.navy);

// -------- schema sampling (for request-body examples) --------------------
function resolveRef(ref) {
  const name = ref.replace('#/components/schemas/', '');
  return (doc_.components && doc_.components.schemas && doc_.components.schemas[name]) || {};
}
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
    case 'object': default: {
      const props = schema.properties;
      if (!props) return {};
      const o = {};
      for (const [k, v] of Object.entries(props)) o[k] = sample(v, depth + 1);
      return o;
    }
  }
}

// -------- flatten ---------------------------------------------------------
const METHODS = ['get', 'post', 'put', 'patch', 'delete'];
function flatten() {
  const ops = [];
  for (const [p, item] of Object.entries(doc_.paths || {})) {
    for (const m of METHODS) {
      const op = item[m];
      if (!op) continue;
      const tag = (op.tags && op.tags[0]) || p.split('/')[1] || 'default';
      ops.push({ method: m, path: p, tag, op });
    }
  }
  return ops;
}
const allOps = flatten();
const byTag = new Map();
for (const o of allOps) { if (!byTag.has(o.tag)) byTag.set(o.tag, []); byTag.get(o.tag).push(o); }
const tags = [...byTag.keys()].sort((a, b) => a.localeCompare(b));

// -------- impact & auth text ---------------------------------------------
function impact(method, p) {
  if (/\/backup\/restore/.test(p)) return { bg: COLORS.delBg, label: 'CRITICAL', text: 'Overwrites the ENTIRE database with a backup. Irreversible except via the auto pre-restore safety backup. Use only in a recovery scenario.' };
  switch (method) {
    case 'get': return { bg: COLORS.readBg, label: 'READ-ONLY', text: 'Safe. Returns data only; does not change anything on the server.' };
    case 'delete': return { bg: COLORS.delBg, label: 'DELETES DATA', text: 'Removes the target record. Generally irreversible — confirm the id before calling.' };
    case 'put': case 'patch': return { bg: COLORS.writeBg, label: 'UPDATES DATA', text: 'Modifies an existing record. Sending a field overwrites its stored value.' };
    case 'post': return { bg: COLORS.writeBg, label: 'WRITES / ACTION', text: 'Creates a record or performs an action. Modifies data or triggers processing.' };
    default: return { bg: COLORS.infoBg, label: 'INFO', text: '' };
  }
}
function authText(op) {
  const sec = op.security || doc_.security;
  if (Array.isArray(sec) && sec.length && sec.some((s) => Object.keys(s).length)) return 'Bearer JWT required.';
  return 'No auth guard declared in the spec (verify before relying on it).';
}

// -------- low-level builders ---------------------------------------------
const gap = (a = 60) => new Paragraph({ spacing: { after: a }, children: [] });

function label(text, color = COLORS.teal) {
  return new Paragraph({
    spacing: { before: 160, after: 40 },
    children: [new TextRun({ text: text.toUpperCase(), bold: true, size: 17, color, font: BODY, characterSpacing: 12 })],
  });
}

function codeBlock(text) {
  const lines = String(text).split('\n');
  const children = [];
  lines.forEach((ln, i) => children.push(new TextRun({ text: ln === '' ? ' ' : ln, font: MONO, size: 17, break: i === 0 ? 0 : 1 })));
  return new Paragraph({
    shading: { type: ShadingType.CLEAR, fill: COLORS.codeBg, color: 'auto' },
    border: {
      top: { style: BorderStyle.SINGLE, size: 2, color: COLORS.hair },
      bottom: { style: BorderStyle.SINGLE, size: 2, color: COLORS.hair },
      left: { style: BorderStyle.SINGLE, size: 12, color: COLORS.teal },
      right: { style: BorderStyle.SINGLE, size: 2, color: COLORS.hair },
    },
    spacing: { before: 40, after: 120 },
    indent: { left: 120, right: 120 },
    children,
  });
}

function calloutImpact(imp, authStr) {
  return new Paragraph({
    shading: { type: ShadingType.CLEAR, fill: imp.bg, color: 'auto' },
    border: { left: { style: BorderStyle.SINGLE, size: 18, color: COLORS.navy } },
    spacing: { before: 40, after: 120 },
    indent: { left: 140, right: 140 },
    children: [
      new TextRun({ text: imp.label + '  ', bold: true, size: 18, font: BODY, color: COLORS.navy }),
      new TextRun({ text: imp.text, size: 18, font: BODY }),
      new TextRun({ text: '   Auth: ' + authStr, size: 17, italics: true, font: BODY, color: COLORS.grayText, break: 1 }),
    ],
  });
}

function cell(text, w, opts = {}) {
  return new TableCell({
    width: { size: w, type: WidthType.DXA },
    shading: opts.head ? { type: ShadingType.CLEAR, fill: COLORS.navy, color: 'auto' } : undefined,
    margins: { top: 40, bottom: 40, left: 90, right: 90 },
    children: [new Paragraph({ children: [new TextRun({ text: String(text), bold: !!opts.head, color: opts.head ? 'FFFFFF' : (opts.mono ? '20303F' : '2A3340'), font: opts.mono ? MONO : BODY, size: opts.head ? 17 : 18 })] })],
  });
}

function paramsTable(params) {
  const widths = [2500, 1100, 1300, 5180];
  const header = new TableRow({ tableHeader: true, children: [cell('Name', widths[0], { head: true }), cell('In', widths[1], { head: true }), cell('Required', widths[2], { head: true }), cell('Description', widths[3], { head: true })] });
  const rows = params.map((pr) => new TableRow({
    children: [
      cell(pr.name, widths[0], { mono: true }),
      cell(pr.in, widths[1]),
      cell(pr.required ? 'yes' : 'no', widths[2]),
      cell(pr.description || '—', widths[3]),
    ],
  }));
  return new Table({
    columnWidths: widths, width: { size: CONTENT_W, type: WidthType.DXA },
    borders: {
      top: { style: BorderStyle.SINGLE, size: 2, color: COLORS.hair }, bottom: { style: BorderStyle.SINGLE, size: 2, color: COLORS.hair },
      left: { style: BorderStyle.SINGLE, size: 2, color: COLORS.hair }, right: { style: BorderStyle.SINGLE, size: 2, color: COLORS.hair },
      insideHorizontal: { style: BorderStyle.SINGLE, size: 2, color: COLORS.hair }, insideVertical: { style: BorderStyle.SINGLE, size: 2, color: COLORS.hair },
    },
    rows: [header, ...rows],
  });
}

function hr() {
  return new Paragraph({ spacing: { before: 60, after: 120 }, border: { bottom: { style: BorderStyle.SINGLE, size: 4, color: COLORS.hair } }, children: [] });
}

// -------- example builders -----------------------------------------------
function curlExample(method, p, op, bodySample) {
  const url = `${SERVER}/${API_PREFIX}${p}`;
  const needsAuth = authText(op).startsWith('Bearer');
  const lines = [`curl -X ${method.toUpperCase()} "${url}"`];
  if (needsAuth) lines[lines.length - 1] += ' \\';
  if (needsAuth) lines.push('  -H "Authorization: Bearer $TOKEN"' + (bodySample ? ' \\' : ''));
  if (bodySample) {
    lines[lines.length - 1] += lines.length === 1 ? ' \\' : '';
    lines.push('  -H "Content-Type: application/json" \\');
    const body = JSON.stringify(bodySample, null, 2).split('\n').map((l, i) => (i === 0 ? l : '  ' + l)).join('\n');
    lines.push(`  -d '${body}'`);
  }
  return lines.join('\n');
}
function responseExample(method) {
  const dataStr = method === 'get' ? '{ /* requested data */ }' : '{ /* affected record */ }';
  return [
    '{',
    '  "success": true,',
    `  "statusCode": ${method === 'post' ? 201 : 200},`,
    '  "message": "Operation successful",',
    `  "data": ${dataStr},`,
    '  "timestamp": "2026-07-25T10:00:00.000Z"',
    '}',
  ].join('\n');
}

// -------- module blurbs ---------------------------------------------------
const BLURBS = {
  'Authentication': 'Login, logout, token refresh and current-user endpoints. Start here to obtain the Bearer token used by every guarded endpoint.',
  'User Management': 'Create, update, and administer application users, their roles, permissions, sessions and audit trail.',
  'Members': 'Member master records: create, update, lookup, KYC documents, photos, signatures and lifecycle status.',
  'Loans': 'Loan application, sanction, disbursement, repayment, EMI schedules, sureties and month-end snapshots.',
  'Deposits': 'Fixed and recurring deposit accounts: creation, installments, closure and maturity.',
  'Reports': 'Read-only reporting endpoints (statements, registers, certificates) with optional PDF/Excel output.',
  'Database Backup': 'Create, list, validate, clean up and RESTORE encrypted database backups.',
  'System Configuration': 'Business rules, interest rates, deposit slabs and system settings.',
  'Role Management': 'User levels, default rights and menu permission mappings.',
};

// -------- build document -------------------------------------------------
const children = [];

// Cover page
children.push(new Paragraph({ spacing: { before: 1600 }, children: [] }));
children.push(new Paragraph({ border: { bottom: { style: BorderStyle.SINGLE, size: 24, color: COLORS.teal } }, spacing: { after: 200 }, children: [] }));
children.push(new Paragraph({ alignment: AlignmentType.LEFT, spacing: { after: 60 }, children: [new TextRun({ text: 'Paper White Technology', size: 26, color: COLORS.teal, bold: true, font: BODY, characterSpacing: 20 })] }));
children.push(new Paragraph({ children: [new TextRun({ text: 'Loan Management System', size: 64, bold: true, color: COLORS.navy, font: BODY })] }));
children.push(new Paragraph({ spacing: { after: 240 }, children: [new TextRun({ text: 'API Reference & Usage Manual', size: 40, color: COLORS.grayText, font: BODY })] }));
children.push(new Paragraph({ border: { bottom: { style: BorderStyle.SINGLE, size: 12, color: COLORS.hair } }, spacing: { after: 240 }, children: [] }));

const coverRows = [
  ['Version', String(doc_.info.version || '1.0')],
  ['Generated', new Date().toISOString().slice(0, 10)],
  ['Total endpoints', String(allOps.length) + ' across ' + tags.length + ' modules'],
  ['Server root', SERVER],
  ['Global prefix', '/' + API_PREFIX + '  (already included in every path below)'],
  ['Authentication', 'Bearer JWT — obtain via POST /' + API_PREFIX + '/auth/login'],
];
children.push(new Table({
  columnWidths: [2600, 7480], width: { size: CONTENT_W, type: WidthType.DXA },
  borders: { top: { style: BorderStyle.NONE }, bottom: { style: BorderStyle.NONE }, left: { style: BorderStyle.NONE }, right: { style: BorderStyle.NONE }, insideHorizontal: { style: BorderStyle.SINGLE, size: 2, color: COLORS.hair }, insideVertical: { style: BorderStyle.NONE } },
  rows: coverRows.map(([k, v]) => new TableRow({ children: [
    new TableCell({ width: { size: 2600, type: WidthType.DXA }, margins: { top: 70, bottom: 70, left: 40 }, children: [new Paragraph({ children: [new TextRun({ text: k, bold: true, color: COLORS.navy, size: 20, font: BODY })] })] }),
    new TableCell({ width: { size: 7480, type: WidthType.DXA }, margins: { top: 70, bottom: 70, left: 40 }, children: [new Paragraph({ children: [new TextRun({ text: v, color: '2A3340', size: 20, font: BODY })] })] }),
  ] })),
}));
children.push(new Paragraph({ children: [new PageBreak()] }));

// About / conventions
children.push(new Paragraph({ heading: HeadingLevel.HEADING_1, children: [new TextRun({ text: 'About this document', color: COLORS.navy })] }));
[
  'This manual documents every HTTP endpoint exposed by the LMS backend. It is generated directly from the live OpenAPI specification, so it always matches the code.',
  'Each entry states what the endpoint does, its impact (whether it reads or changes data), the authentication it needs, its parameters, and a copy-paste working example with a sample response.',
].forEach((t) => children.push(new Paragraph({ spacing: { after: 120 }, children: [new TextRun({ text: t, size: 21, font: BODY })] })));

children.push(label('Base URL & prefix'));
children.push(new Paragraph({ spacing: { after: 100 }, children: [
  new TextRun({ text: 'Every path in this document already includes the ', size: 21, font: BODY }),
  new TextRun({ text: '/' + API_PREFIX, font: MONO, size: 19 }),
  new TextRun({ text: ' prefix. Prepend the server root, e.g. ', size: 21, font: BODY }),
  new TextRun({ text: SERVER + '/' + API_PREFIX + '/auth/login', font: MONO, size: 19 }),
  new TextRun({ text: '.', size: 21, font: BODY }),
]}));

children.push(label('Authentication flow'));
children.push(new Paragraph({ spacing: { after: 60 }, children: [new TextRun({ text: '1. POST /auth/login with username & password.  2. Copy accessToken from the response.  3. Send it as an Authorization: Bearer header on every other call.', size: 21, font: BODY })] }));
children.push(codeBlock('# 1) Log in and capture the token\nTOKEN=$(curl -s -X POST "' + SERVER + '/' + API_PREFIX + '/auth/login" \\\n  -H "Content-Type: application/json" \\\n  -d \'{ "username": "admin", "password": "your-password" }\' | jq -r .data.accessToken)\n\n# 2) Use it\ncurl "' + SERVER + '/' + API_PREFIX + '/members" -H "Authorization: Bearer $TOKEN"'));

children.push(label('Standard response envelope'));
children.push(new Paragraph({ spacing: { after: 40 }, children: [new TextRun({ text: 'Successful responses are wrapped in this envelope; the payload is in "data". Errors set success=false and carry an HTTP 4xx/5xx status with a message.', size: 21, font: BODY })] }));
children.push(codeBlock('{\n  "success": true,\n  "statusCode": 200,\n  "message": "Operation successful",\n  "data": { /* endpoint payload */ },\n  "timestamp": "2026-07-25T10:00:00.000Z"\n}'));

children.push(label('Impact legend'));
[
  ['READ-ONLY', 'Safe. Returns data only.'],
  ['WRITES / ACTION', 'POST — creates a record or performs an action.'],
  ['UPDATES DATA', 'PUT / PATCH — modifies an existing record.'],
  ['DELETES DATA', 'DELETE — removes a record (usually irreversible).'],
  ['CRITICAL', 'Destructive, system-wide (e.g. database restore).'],
].forEach(([k, v]) => children.push(new Paragraph({ spacing: { after: 40 }, bullet: { level: 0 }, children: [new TextRun({ text: k + ' — ', bold: true, size: 20, font: BODY, color: COLORS.navy }), new TextRun({ text: v, size: 20, font: BODY })] })));

children.push(new Paragraph({ children: [new PageBreak()] }));

// TOC
children.push(new Paragraph({ heading: HeadingLevel.HEADING_1, children: [new TextRun({ text: 'Contents', color: COLORS.navy })] }));
children.push(new TableOfContents('Contents', { hyperlink: true, headingStyleRange: '1-2' }));
children.push(new Paragraph({ children: [new PageBreak()] }));

// Modules
tags.forEach((tag, ti) => {
  if (ti > 0) children.push(new Paragraph({ children: [new PageBreak()] }));
  const list = byTag.get(tag).sort((a, b) => a.path.localeCompare(b.path) || a.method.localeCompare(b.method));
  children.push(new Paragraph({ heading: HeadingLevel.HEADING_1, spacing: { after: 40 }, children: [new TextRun({ text: tag, color: COLORS.navy })] }));
  children.push(new Paragraph({ spacing: { after: 60 }, children: [new TextRun({ text: (BLURBS[tag] || 'Endpoints in the ' + tag + ' module.') + '  (' + list.length + ' endpoint' + (list.length > 1 ? 's' : '') + ')', size: 20, italics: true, color: COLORS.grayText, font: BODY })] }));
  children.push(hr());

  list.forEach((o, idx) => {
    const { method, path: p, op } = o;
    // Heading with colored method + mono path
    children.push(new Paragraph({
      heading: HeadingLevel.HEADING_2,
      spacing: { before: 160, after: 40 },
      children: [
        new TextRun({ text: method.toUpperCase(), bold: true, color: methodColor(method), font: BODY }),
        new TextRun({ text: '  ' + p, font: MONO, color: COLORS.navy }),
      ],
    }));
    // description
    if (op.summary) children.push(new Paragraph({ spacing: { after: 40 }, children: [new TextRun({ text: op.summary, size: 21, font: BODY })] }));
    if (op.description && op.description !== op.summary) children.push(new Paragraph({ spacing: { after: 40 }, children: [new TextRun({ text: op.description, size: 20, font: BODY, color: COLORS.grayText })] }));
    // impact + auth callout
    children.push(calloutImpact(impact(method, p), authText(op)));
    // params
    const params = (op.parameters || []).filter((x) => x.in === 'path' || x.in === 'query');
    if (params.length) { children.push(label('Parameters')); children.push(paramsTable(params)); children.push(gap(40)); }
    // request body
    const jsonSchema = op.requestBody && op.requestBody.content && op.requestBody.content['application/json'] && op.requestBody.content['application/json'].schema;
    const bodySample = jsonSchema ? sample(jsonSchema) : null;
    if (bodySample && Object.keys(bodySample).length) { children.push(label('Request body (JSON)')); children.push(codeBlock(JSON.stringify(bodySample, null, 2))); }
    // example request
    children.push(label('Example request'));
    children.push(codeBlock(curlExample(method, p, op, bodySample && Object.keys(bodySample).length ? bodySample : null)));
    // example response
    children.push(label('Example response'));
    children.push(codeBlock(responseExample(method)));
    if (idx < list.length - 1) children.push(hr());
  });
});

// -------- assemble & write -----------------------------------------------
const document = new Document({
  creator: 'Paper White Technology',
  title: 'LMS API Reference & Usage Manual',
  description: 'Auto-generated API documentation',
  features: { updateFields: true },
  styles: {
    default: { document: { run: { font: BODY, size: 21, color: '2A3340' } } },
    paragraphStyles: [
      { id: 'Heading1', name: 'Heading 1', basedOn: 'Normal', next: 'Normal', quickFormat: true, run: { size: 30, bold: true, color: COLORS.navy, font: BODY }, paragraph: { spacing: { before: 240, after: 120 }, outlineLevel: 0 } },
      { id: 'Heading2', name: 'Heading 2', basedOn: 'Normal', next: 'Normal', quickFormat: true, run: { size: 24, bold: true, color: COLORS.navy, font: BODY }, paragraph: { spacing: { before: 160, after: 60 }, outlineLevel: 1 } },
    ],
  },
  sections: [{
    properties: { page: { size: { width: 12240, height: 15840 }, margin: { top: 1080, bottom: 1080, left: 1080, right: 1080 } } },
    footers: {},
    children,
  }],
});

Packer.toBuffer(document).then((buf) => {
  fs.writeFileSync(OUT, buf);
  console.log('Wrote ' + OUT + ' (' + (buf.length / 1024 / 1024).toFixed(2) + ' MB), ' + allOps.length + ' endpoints, ' + tags.length + ' modules.');
});
