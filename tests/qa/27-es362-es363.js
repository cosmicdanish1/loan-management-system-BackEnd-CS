// Verification of ES-362 (pass / reverse / reject need Transaction Auth + Pass Transactions right) and
// ES-363 (certificate download path traversal). Creates its own temp users (QA_PASS_*), QA member, QA vouchers and one QA file
// uploads/certificates/qa_es363_test.pdf (removed at the end). Env: QA_USER / QA_PASS.
const fs = require('fs'), path = require('path');
const { http, login, Suite, BASE } = require('./lib');
const { Client } = require('pg');
require('dotenv').config({ path: path.resolve(__dirname, '../../.env') });
const mem = () => ({ prefix: 'MR', f_name: 'QATEST', m_name: '', l_name: 'T' + Date.now().toString().slice(-7), sex: 'M', desig: 'CLERK', present_address: 'QA', permanent_address: 'QA', wingno: '1', officeno: 1, age: '30', dob: '1995-05-05', dor: '2035-05-05', gross_salary: 1, basic_pay: 1, nominee_name: 'QA', nominee_address: 'X', nominee_relation: 'X', declare_date: '2026-10-16', memb_date: '2026-10-16', flg_incometax: 'N', flg_insured: 'N', insureamt: 0, remarks: 'QA', dept_name: 'QA', isactive: 'Y', flg_retire: 'N', phoneno: '9000000031', fathers_name: 'QA', compulsory_deposit: 0, share_amount: 0, cast_category: '' });

(async () => {
  const s = new Suite('27-es362-es363');
  const { token } = await login();
  const adm = (m, u, b) => http(m, u, { token, body: b, timeout: 60000 });
  const pg = new Client({ host: process.env.DB_HOST, port: process.env.DB_PORT, user: process.env.DB_USERNAME, password: process.env.DB_PASSWORD, database: process.env.DB_DATABASE });
  await pg.connect();
  const rows = async (sql, p) => (await pg.query(sql, p)).rows;
  const mb = (await adm('POST', '/members/save-member', mem())).json.data.mbno;
  const st = Date.now().toString().slice(-6);
  const pw = 'Tmp#Pass' + st + 'x';
  const mkUser = async (tag, role, allow) => {
    const name = `QA_PASS_${tag}_${st}`;
    const c = await adm('POST', '/admin/users', { username: name, email: `${name.toLowerCase()}@bank.local`, password: pw, firstName: 'QA', lastName: tag, role, allowPassTransactions: allow });
    const id = c.json && c.json.data && (c.json.data.id || c.json.data.userid);
    const lg = await login(name, pw);
    return { name, id, token: lg.token };
  };
  const newVoucher = async (tok = token) => {
    const r = await http('POST', '/transactions/voucher', { token: tok, body: { voucherType: 'RECEIPT', voucherDate: '2026-10-18', description: 'QA 362', memberId: mb, paymentMethod: 'CASH', transactions: [{ amount: 10, code: 'L1004', description: 'QA' }] } });
    return r.json && r.json.data && r.json.data.voucherNo;
  };
  const status = async (no) => (await rows(`select status from vouchers where "voucherNumber"=$1`, [no]))[0]?.status;
  const ledgerRows = async (no) => Number((await rows(`select count(*) c from ledger where receipt_vchr_no=$1`, [no]))[0].c);

  const clerkOff = await mkUser('clerkoff', 'clerk', false);
  const adminOff = await mkUser('adminoff', 'administrator', false);
  s.check('PA-00', 'Temp users created and logged in (clerk with the flag OFF, administrator with the flag OFF)', !!clerkOff.token && !!adminOff.token, `${!!clerkOff.token} ${!!adminOff.token}`);

  // ---- flag OFF: refused for pass / reverse / reject, voucher untouched
  const v1 = await newVoucher(clerkOff.token);
  s.check('PA-01', 'A user without Transaction Auth can still CREATE (stage) a voucher', !!v1, v1);
  const p1 = await http('POST', `/transactions/pass/${v1}`, { token: clerkOff.token, body: { postedBy: 'x' } });
  s.check('PA-02', 'Clerk, flag OFF: pass -> 403 PASS_AUTHORITY_REQUIRED', p1.status === 403 && /Transaction Auth/.test(p1.text || ''), `${p1.status} ${(p1.text || '').slice(0, 110)}`);
  s.check('PA-03', 'The refused pass left the voucher PENDING with no ledger rows', (await status(v1)) === 'PENDING' && (await ledgerRows(v1)) === 0, `${await status(v1)} ledger ${await ledgerRows(v1)}`);
  const d1 = await http('DELETE', `/transactions/voucher/${v1}`, { token: clerkOff.token });
  s.check('PA-04', 'Clerk, flag OFF: reject (delete) -> 403 and the voucher still exists', d1.status === 403 && (await status(v1)) === 'PENDING', `${d1.status} ${await status(v1)}`);
  const r1 = await http('POST', `/transactions/reverse/${v1}`, { token: clerkOff.token, body: {} });
  s.check('PA-05', 'Clerk, flag OFF: reverse -> 403', r1.status === 403, r1.status);
  const pu = await http('POST', '/transactions/pass/NOPE-VCH', { token: clerkOff.token, body: {} });
  s.check('PA-06', 'Refusal comes BEFORE any voucher lookup (unknown voucher also 403, not 400)', pu.status === 403, pu.status);

  // ---- flag OFF overrides the administrator level
  const v2 = await newVoucher();
  const p2 = await http('POST', `/transactions/pass/${v2}`, { token: adminOff.token, body: {} });
  s.check('PA-07', 'Administrator-level user with the flag OFF -> 403 (the flag is not bypassed by the level)', p2.status === 403, `${p2.status} ${(p2.text || '').slice(0, 90)}`);

  // ---- admin with the flag ON still works (regression)
  const p3 = await adm('POST', `/transactions/pass/${v2}`, { postedBy: 'QA' });
  s.check('PA-08', 'Administrator with the flag ON can pass', p3.status < 300 && p3.status > 0, `${p3.status} ${(p3.text || '').slice(0, 90)}`);
  s.check('PA-09', 'Passing posted ledger rows', (await ledgerRows(v2)) >= 2, await ledgerRows(v2));
  const r3 = await adm('POST', `/transactions/reverse/${v2}`, { reversedBy: 'QA' });
  s.check('PA-10', 'Administrator with the flag ON can reverse', r3.status < 300 && r3.status > 0, `${r3.status} ${(r3.text || '').slice(0, 90)}`);
  const v3 = await newVoucher();
  const d3 = await adm('DELETE', `/transactions/voucher/${v3}`);
  s.check('PA-11', 'Administrator with the flag ON can reject a pending voucher', d3.status < 300 && d3.status > 0, d3.status);

  // ---- switching the flag takes effect immediately (same token)
  const v4 = await newVoucher();
  const on = await adm('PUT', `/admin/users/${adminOff.id}`, { allowPassTransactions: true });
  const p4 = await http('POST', `/transactions/pass/${v4}`, { token: adminOff.token, body: {} });
  s.check('PA-12', 'After an administrator switches the flag ON, the same user (same token) can pass at once', on.status < 300 && p4.status < 300 && p4.status > 0, `${on.status} / ${p4.status} ${(p4.text || '').slice(0, 80)}`);
  const off = await adm('PUT', `/admin/users/${adminOff.id}`, { allowPassTransactions: false });
  const v5 = await newVoucher();
  const p5 = await http('POST', `/transactions/pass/${v5}`, { token: adminOff.token, body: {} });
  s.check('PA-13', 'After the flag is switched OFF again, the same token is refused at once', off.status < 300 && p5.status === 403, `${off.status} / ${p5.status}`);
  await adm('POST', `/transactions/reverse/${v4}`, { reversedBy: 'QA' });
  await adm('DELETE', `/transactions/voucher/${v5}`);

  // ---- other endpoints unaffected for a user without the flag
  const me = await http('GET', '/auth/me', { token: clerkOff.token });
  const lc = await http('GET', '/transactions/vouchers/pending', { token: clerkOff.token });
  s.check('PA-14', 'Reading pending vouchers and /auth/me still works for a user without the flag', me.status === 200 && lc.status === 200, `${me.status}/${lc.status}`);
  await adm('DELETE', `/transactions/voucher/${v1}`);

  // ================= ES-363 =================
  const dir = path.resolve(__dirname, '../../uploads/certificates');
  fs.mkdirSync(dir, { recursive: true });
  const legit = path.join(dir, 'qa_es363_test.pdf');
  fs.writeFileSync(legit, '%PDF-1.4\n% QA test file\n');
  const dl = (name) => http('GET', `/deposits/certificates/download/${name}`, { token, raw: true, timeout: 30000 });
  for (const [id, n] of [['PT-01', '..%5C..%5Cpackage.json'], ['PT-02', '..%2F..%2Fpackage.json'], ['PT-03', '%2e%2e%5c%2e%2e%5cpackage.json'], ['PT-04', '..%5Cpackage.json'], ['PT-05', 'subfolder%5Cfile.pdf'], ['PT-06', 'sub%2Ffile.pdf'], ['PT-07', 'C%3A%5CWindows%5Cwin.ini'], ['PT-08', '%2Fetc%2Fpasswd'], ['PT-09', 'x%00.pdf'], ['PT-10', '....%5C%5Cpackage.json'], ['PT-11', '.'], ['PT-12', '..']]) {
    const r = await dl(n);
    s.check(id, `Download name '${decodeURIComponent(n).replace(/\0/g, '\\0')}' is refused (400/404) and never answers 200`, r.status === 400 || r.status === 404, `${r.status} ${(r.text || '').slice(0, 90)}`);
  }
  const okDl = await dl('qa_es363_test.pdf');
  s.check('PT-13', 'A genuine certificate file name still answers 200', okDl.status === 200, `${okDl.status} ${(okDl.text || '').slice(0, 100)}`);
  const body = okDl.text || '';
  console.log('INFO genuine download body starts with:', body.slice(0, 80).replace(/\s+/g, ' '));
  console.log('INFO PT-14 (separate bug): genuine download content-type=' + (okDl.headers && okDl.headers.get('content-type')) + ' but the body is a JSON wrapper, not the PDF bytes; tracked in the follow-up Jira bug');
  const miss = await dl('does_not_exist.pdf');
  s.check('PT-15', 'A name that is clean but does not exist -> 404', miss.status === 404, miss.status);
  const noAuth = await http('GET', '/deposits/certificates/download/qa_es363_test.pdf');
  s.check('PT-16', 'Download without a token -> 401', noAuth.status === 401, noAuth.status);
  fs.unlinkSync(legit);

  for (const u of [clerkOff, adminOff]) await adm('DELETE', `/admin/users/${u.id}`);
  const left = await rows(`select count(*) c from usermaster where susername like $1`, [`QA\\_PASS\\_%\\_${st}`]);
  s.check('PA-CLEAN', 'Temp users removed', Number(left[0].c) === 0, left[0].c);
  await pg.end();
  process.exit(s.finish() ? 1 : 0);
})();
