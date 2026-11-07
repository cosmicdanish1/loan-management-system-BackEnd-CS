// Verification of the four low-priority fixes: ES-266 (usernames unique ignoring case), ES-324 (journal on a single account),
// ES-331 (handled 4xx logged as warn, 5xx as error - checked on the filter itself, see 21-filter-check.ts), ES-354 (demand generate month/year validation).
// Uses only records created here. Env: QA_USER / QA_PASS.
const { http, login, Suite } = require('./lib');
const { Client } = require('pg');
require('dotenv').config({ path: require('path').resolve(__dirname, '../../.env') });

(async () => {
  const s = new Suite('21-low-fixes');
  const { token } = await login();
  const call = (m, u, b) => http(m, u, { token, body: b, timeout: 120000 });
  const pg = new Client({ host: process.env.DB_HOST, port: process.env.DB_PORT, user: process.env.DB_USERNAME, password: process.env.DB_PASSWORD, database: process.env.DB_DATABASE });
  await pg.connect();
  const rows = async (sql, p) => (await pg.query(sql, p)).rows;
  const ids = [];

  // ---------------- ES-266
  const base = 'QA_LOW_' + Date.now().toString().slice(-7);
  const mk = (name, email) => call('POST', '/admin/users', { username: name, email, password: 'Tmp#Pass123', firstName: 'QA', lastName: 'Low', role: 'data_operator' });
  const u1 = await mk(base, `${base.toLowerCase()}@bank.local`);
  const id1 = u1.json && u1.json.data && (u1.json.data.id || u1.json.data.userid); if (id1) ids.push(id1);
  s.check('LF-266-1', 'Create a user', [200, 201].includes(u1.status) && !!id1, `${u1.status} ${(u1.text || '').slice(0, 100)}`);
  const dupExact = await mk(base, `x1_${base.toLowerCase()}@bank.local`);
  s.check('LF-266-2', 'Same username, same case -> 409', dupExact.status === 409, dupExact.status);
  const dupLower = await mk(base.toLowerCase(), `x2_${base.toLowerCase()}@bank.local`);
  const dupLowerId = dupLower.json && dupLower.json.data && (dupLower.json.data.id || dupLower.json.data.userid); if (dupLowerId) ids.push(dupLowerId);
  s.check('LF-266-3', 'Same username in lower case -> 409 (was accepted)', dupLower.status === 409, `${dupLower.status} ${(dupLower.text || '').slice(0, 100)}`);
  const dupUpper = await mk(base.toUpperCase(), `x3_${base.toLowerCase()}@bank.local`);
  const dupUpperId = dupUpper.json && dupUpper.json.data && (dupUpper.json.data.id || dupUpper.json.data.userid); if (dupUpperId) ids.push(dupUpperId);
  s.check('LF-266-4', 'Same username in upper case -> 409', dupUpper.status === 409, `${dupUpper.status}`);
  const underscore = await mk(base.replace('_LOW_', 'xLOWx'), `x4_${base.toLowerCase()}@bank.local`);
  const underId = underscore.json && underscore.json.data && (underscore.json.data.id || underscore.json.data.userid); if (underId) ids.push(underId);
  s.check('LF-266-5', "A different name that differs only where the first has '_' is NOT treated as a duplicate (no wildcard matching)", [200, 201].includes(underscore.status), `${underscore.status} ${(underscore.text || '').slice(0, 100)}`);
  const other = await mk(base + '_2', `x5_${base.toLowerCase()}@bank.local`);
  const otherId = other.json && other.json.data && (other.json.data.id || other.json.data.userid); if (otherId) ids.push(otherId);
  s.check('LF-266-6', 'A genuinely different username is still accepted', [200, 201].includes(other.status), other.status);
  if (id1) {
    const ren = await call('PUT', `/admin/users/${id1}`, { username: base.toLowerCase() });
    s.check('LF-266-7', 'Changing the case of a user\'s own name is allowed', ren.status < 300, `${ren.status} ${(ren.text || '').slice(0, 100)}`);
    if (otherId) {
      const clash = await call('PUT', `/admin/users/${otherId}`, { username: base.toUpperCase() });
      s.check('LF-266-8', "Renaming another user to a name that exists in different case -> 409", clash.status === 409, `${clash.status}`);
    }
  }
  const login1 = await login(base.toLowerCase(), 'Tmp#Pass123');
  s.check('LF-266-9', 'Existing login still works after the change', !!login1.token, login1.res.status);

  // ---------------- ES-324
  const j = (rowsArr, o = {}) => ({ transferType: 'headToHead', narration: 'QA low-fix journal', rows: rowsArr, ...o });
  const before = Number((await rows(`select count(*) c from ledger where narration='QA low-fix journal'`))[0].c);
  const same = await call('POST', '/transactions/journal/post', j([{ code: 'L1004', debit: 100, credit: 0 }, { code: 'L1004', debit: 0, credit: 100 }]));
  const afterSame = Number((await rows(`select count(*) c from ledger where narration='QA low-fix journal'`))[0].c);
  s.check('LF-324-1', 'Journal with the same head on debit and credit -> 400 and nothing posted', same.status === 400 && afterSame === before, `${same.status} ${(same.text || '').slice(0, 110)}; rows ${before} -> ${afterSame}`);
  const good = await call('POST', '/transactions/journal/post', j([{ code: 'L1004', debit: 100, credit: 0 }, { code: 'L1001', debit: 0, credit: 100 }]));
  s.check('LF-324-2', 'Balanced journal on two different heads still posts', good.status < 300 && good.status > 0, `${good.status} ${(good.text || '').slice(0, 110)}`);
  const three = await call('POST', '/transactions/journal/post', j([{ code: 'L1004', debit: 100, credit: 0 }, { code: 'L1001', debit: 0, credit: 150 }, { code: 'L1004', debit: 50, credit: 0 }]));
  s.check('LF-324-3', 'Journal where one head appears on both sides but another head is involved still posts (legitimate)', three.status < 300 && three.status > 0, `${three.status} ${(three.text || '').slice(0, 110)}`);
  const qm = (await rows(`select mbno from member_master where f_name='QATEST' order by mbno desc limit 2`)).map(r => Number(r.mbno));
  const m2m = await call('POST', '/transactions/journal/post', j([{ mbno: qm[0], code: 'L1004', debit: 20, credit: 0 }, { mbno: qm[1], code: 'L1004', debit: 0, credit: 20 }], { transferType: 'memberToMember' }));
  s.check('LF-324-4', 'Member-to-member journal on the SAME head but different members still posts', m2m.status < 300 && m2m.status > 0, `${m2m.status} ${(m2m.text || '').slice(0, 110)}`);
  const same2 = await call('POST', '/transactions/journal/post', j([{ mbno: qm[0], code: 'L1004', debit: 20, credit: 0 }, { mbno: qm[0], code: 'L1004', debit: 0, credit: 20 }], { transferType: 'memberToMember' }));
  s.check('LF-324-5', 'Member-to-member journal from a member to the same member on the same head -> 400', same2.status === 400, `${same2.status} ${(same2.text || '').slice(0, 100)}`);
  s.check('LF-324-6', 'Existing journal validation still works (unbalanced -> 400)', (await call('POST', '/transactions/journal/post', j([{ code: 'L1004', debit: 100, credit: 0 }, { code: 'L1001', debit: 0, credit: 90 }]))).status === 400);

  // ---------------- ES-354
  const g = (month, year) => call('POST', '/transactions/demand-generation/generate', { month, year, memberNos: [1999999999] });
  const cnt = async () => Number((await rows(`select count(*) c from demand_master`))[0].c);
  const d0 = await cnt();
  for (const [id, t, m, y] of [['LF-354-1', "month 'XYZ'", 'XYZ', '2031'], ['LF-354-2', "year 'abcd'", 'JAN', 'abcd'], ['LF-354-3', 'year 1800', 'JAN', '1800'], ['LF-354-4', 'year 99999', 'JAN', '99999'], ['LF-354-5', 'empty month', '', '2031'], ['LF-354-6', 'year in the far future (2099)', 'JAN', '2099']]) {
    const r = await g(m, y);
    s.check(id, `Generate with ${t} -> 400 (was 500 or accepted)`, r.status === 400, `${r.status} ${(r.text || '').slice(0, 110)}`);
  }
  s.check('LF-354-7', 'Refused requests created no demand rows', (await cnt()) === d0, `${d0} -> ${await cnt()}`);
  const okLower = await g('jan', String(new Date().getFullYear() + 5));
  const d1 = await cnt();
  s.check('LF-354-8', "Valid request (month 'jan' in lower case, year +5) is accepted: 0 rows because the member does not exist, no error", okLower.status < 300 && okLower.status > 0 && d1 === d0, `${okLower.status} ${(okLower.text || '').slice(0, 120)}; rows ${d0} -> ${d1}`);
  const repeat = await call('POST', '/transactions/demand-generation/generate', { month: 'JAN', year: '2031', memberNos: [610022986] });
  s.check('LF-354-9', 'An existing month (JAN 2031, created earlier) is still reported as already generated, not duplicated', repeat.status < 300 && (await cnt()) === d0 + 0, `${repeat.status} ${(repeat.text || '').slice(0, 130)}`);

  // cleanup: only the users this suite created
  for (const id of ids) await call('DELETE', `/admin/users/${id}`);
  const left = await rows(`select count(*) c from usermaster where susername ilike $1`, [base.replace(/_/g, '\\_') + '%']);
  s.check('LF-CLEAN', 'Users created by this suite were removed', Number(left[0].c) === 0, `left ${left[0].c}`);
  await pg.end();
  process.exit(s.finish() ? 1 : 0);
})();
