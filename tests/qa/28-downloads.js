// ES-373: files must be delivered byte for byte, while normal JSON responses keep the standard envelope.
// Uses a QA member's signature (upload then download) and one QA file in uploads/certificates (removed at the end).
const fs = require('fs'), path = require('path'), crypto = require('crypto');
const { http, login, Suite, BASE } = require('./lib');
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');

async function raw(method, url, token, body, headers = {}) {
  const r = await fetch(BASE + url, { method, headers: { Authorization: 'Bearer ' + token, ...headers }, body, signal: AbortSignal.timeout(60000) });
  return { status: r.status, type: r.headers.get('content-type') || '', disp: r.headers.get('content-disposition') || '', buf: Buffer.from(await r.arrayBuffer()) };
}

(async () => {
  const s = new Suite('28-downloads');
  const { token } = await login();
  const dir = path.resolve(__dirname, '../../uploads/certificates');
  fs.mkdirSync(dir, { recursive: true });

  // 1. certificate: 64 KB of pseudo-random bytes with a PDF header, compared by SHA-256
  const payload = Buffer.concat([Buffer.from('%PDF-1.4\n'), crypto.randomBytes(64 * 1024), Buffer.from('\n%%EOF\n')]);
  const f = path.join(dir, 'qa_es373_test.pdf');
  fs.writeFileSync(f, payload);
  const d = await raw('GET', '/deposits/certificates/download/qa_es373_test.pdf', token);
  s.check('DL-01', 'Certificate download answers 200', d.status === 200, d.status);
  s.check('DL-02', 'Content-Type is application/pdf and Content-Disposition names the file', /application\/pdf/.test(d.type) && /qa_es373_test\.pdf/.test(d.disp), `${d.type} | ${d.disp}`);
  s.check('DL-03', 'The body is the file, byte for byte (same length and SHA-256)', d.buf.length === payload.length && sha(d.buf) === sha(payload), `got ${d.buf.length} bytes sha ${sha(d.buf).slice(0, 12)} vs ${payload.length} bytes sha ${sha(payload).slice(0, 12)}; starts: ${d.buf.slice(0, 40).toString('latin1').replace(/\s+/g, ' ')}`);
  s.check('DL-04', 'The body is not the JSON envelope', !d.buf.slice(0, 20).toString('utf8').startsWith('{"success"'), d.buf.slice(0, 30).toString('utf8'));
  fs.unlinkSync(f);

  // 2. a missing file and traversal still give JSON errors
  const nf = await raw('GET', '/deposits/certificates/download/qa_missing.pdf', token);
  s.check('DL-05', 'Missing file -> 404 with the JSON error body', nf.status === 404 && /Certificate file not found/.test(nf.buf.toString()), `${nf.status} ${nf.buf.toString().slice(0, 80)}`);
  const tr = await raw('GET', '/deposits/certificates/download/..%5C..%5Cpackage.json', token);
  s.check('DL-06', 'Traversal attempt -> 400 and no file content', tr.status === 400 && !/loan-management-backend/.test(tr.buf.toString()), `${tr.status}`);

  // 3. member signature upload + download (png)
  const png = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), crypto.randomBytes(2048)]);
  const mk = await http('POST', '/members/save-member', { token, body: { prefix: 'MR', f_name: 'QATEST', m_name: '', l_name: 'D' + Date.now().toString().slice(-7), sex: 'M', desig: 'CLERK', present_address: 'QA', permanent_address: 'QA', wingno: '1', officeno: 1, age: '30', dob: '1995-05-05', dor: '2035-05-05', gross_salary: 1, basic_pay: 1, nominee_name: 'QA', nominee_address: 'X', nominee_relation: 'X', declare_date: '2026-10-16', memb_date: '2026-10-16', flg_incometax: 'N', flg_insured: 'N', insureamt: 0, remarks: 'QA', dept_name: 'QA', isactive: 'Y', flg_retire: 'N', phoneno: '9000000041', fathers_name: 'QA', compulsory_deposit: 0, share_amount: 0, cast_category: '' } });
  const mb = mk.json.data.mbno;
  const fd = new FormData();
  fd.append('file', new Blob([png], { type: 'image/png' }), 'sig.png');
  const up = await raw('POST', `/members/master/${mb}/signature`, token, fd);
  s.check('DL-07', 'Signature upload for the QA member works', up.status < 300 && up.status > 0, `${up.status} ${up.buf.toString().slice(0, 100)}`);
  const sg = await raw('GET', `/members/master/${mb}/signature`, token);
  s.check('DL-08', 'Signature download is the uploaded image, byte for byte, as image/png', sg.status === 200 && /image\/png/.test(sg.type) && sha(sg.buf) === sha(png), `${sg.status} ${sg.type} ${sg.buf.length} bytes (uploaded ${png.length}); starts: ${sg.buf.slice(0, 30).toString('latin1').replace(/[^\x20-\x7e]/g, '.')}`);
  const del = await http('DELETE', `/members/master/${mb}/signature`, { token });
  s.check('DL-09', 'The QA signature is deleted again (own file)', del.status < 300, del.status);

  // 4. normal JSON routes keep the envelope
  const j = await http('GET', '/loans/cases?limit=1', { token });
  s.check('DL-10', 'A normal JSON route still returns {success, statusCode, message, data, timestamp}', j.json && j.json.success === true && j.json.statusCode === 200 && 'data' in j.json && 'timestamp' in j.json, (j.text || '').slice(0, 100));
  const h = await http('GET', '/health');
  s.check('DL-11', 'Health still answers 200 JSON', h.status === 200 && !!h.json, h.status);
  const created = await http('POST', '/loans/calculate-emi', { token, body: { principal: 100000, annualRate: 12, tenureMonths: 12 } });
  s.check('DL-12', 'A POST route still returns 201 with the envelope', created.status === 201 && created.json && created.json.success === true && created.json.data && created.json.data.emi > 0, `${created.status}`);
  s.check('DL-13', 'Swagger JSON (docs-json) is still served', (await http('GET', BASE.replace(/\/api\/v1$/, '') + '/api/docs-json', { raw: true })).status === 200);
  process.exit(s.finish() ? 1 : 0);
})();
