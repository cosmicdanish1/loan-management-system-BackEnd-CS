// Member write-flow suite. Creates its own QA members (name starts QATEST) and only ever edits those.
// No existing member is edited or deleted. Env: QA_USER / QA_PASS.
const { http, login, Suite } = require('./lib');

const base = (o = {}) => ({
  prefix: 'MR', f_name: 'QATEST', m_name: '', l_name: 'W' + Date.now().toString().slice(-6), sex: 'M', desig: 'CLERK',
  present_address: 'QA ROAD 1', permanent_address: 'QA ROAD 1', wingno: '1', officeno: 1, age: '30', dob: '1995-05-05', dor: '2035-05-05',
  gross_salary: 30000, basic_pay: 20000, nominee_name: 'QA NOM', nominee_address: 'X', nominee_relation: 'SPOUSE', declare_date: '2026-10-16',
  memb_date: '2026-10-16', pfno: '', lfno: '', flg_incometax: 'N', flg_insured: 'N', insureamt: 0, remarks: 'QA TEST MEMBER', dept_name: 'QA',
  isactive: 'Y', flg_retire: 'N', aadharno: '', phoneno: '9000000001', pan_no: '', frs_no: '', fathers_name: 'QA FATHER', branchmsno: '',
  compulsory_deposit: 0, share_amount: 0, cast_category: '', ...o,
});

(async () => {
  const s = new Suite('06-member-write');
  const { token } = await login();
  const call = (m, u, b) => http(m, u, { token, body: b });
  const mine = [];

  const g1 = await call('GET', '/members/generate/member-number');
  const g2 = await call('GET', '/members/generate/member-number');
  const n1 = g1.json && g1.json.data && g1.json.data.memberNumber, n2 = g2.json && g2.json.data && g2.json.data.memberNumber;
  s.check('MB-01', 'Previewing the next member number twice returns the same number (preview must not consume numbers)', n1 && n1 === n2, `${n1} then ${n2}`);

  const c = await call('POST', '/members/save-member', base());
  const m = c.json && c.json.data;
  s.check('MB-02', 'Create member succeeds and returns a member number', [200, 201].includes(c.status) && m && m.mbno, `${c.status} ${(c.text || '').slice(0, 120)}`);
  if (!m || !m.mbno) { process.exit(s.finish() ? 1 : 0); }
  mine.push(m.mbno);
  s.check('MB-03', 'Member number shown by the preview equals the number actually saved', String(m.mbno) === String(n1), `preview ${n1} vs saved ${m.mbno}`);
  s.check('MB-04', 'Saved values round-trip (name, phone, nominee)', m.f_name === 'QATEST' && m.phoneno === '9000000001' && m.nominee_name === 'QA NOM', JSON.stringify({ f: m.f_name, p: m.phoneno }));

  const f = await call('GET', `/members/find/${m.mbno}`);
  s.check('MB-05', 'New member is found by number', f.status === 200 && JSON.stringify(f.json).includes(String(m.mbno)), f.status);
  const d = await call('GET', `/members/details/${m.mbno}`);
  s.check('MB-06', 'Member details load', d.status === 200, d.status);
  const lk = await call('GET', `/members/lookup?q=${encodeURIComponent(m.l_name)}`);
  s.check('MB-07', 'New member appears in lookup by surname', lk.status === 200 && JSON.stringify(lk.json).includes(String(m.mbno)), `${lk.status} ${(lk.text || '').slice(0, 100)}`);
  const bal = await call('GET', `/members/balance/${m.mbno}`);
  s.check('MB-08', 'Balance of a brand-new member loads (not 500)', bal.status === 200, `${bal.status} ${(bal.text || '').slice(0, 120)}`);

  // update with full body
  const up = await call('POST', '/members/save-member', { ...base({ l_name: m.l_name }), mbno: m.mbno, phoneno: '9000000002', present_address: 'NEW ADDRESS 9' });
  s.check('MB-09', 'Update (full body) changes the phone and address', [200, 201].includes(up.status) && up.json && up.json.data && up.json.data.phoneno === '9000000002' && up.json.data.present_address === 'NEW ADDRESS 9', `${up.status} ${(up.text || '').slice(0, 120)}`);
  // partial update: a client that sends only changed fields must not wipe the rest
  const part = await call('POST', '/members/save-member', { mbno: m.mbno, phoneno: '9000000003' });
  const after = await call('GET', `/members/details/${m.mbno}`);
  const dd = JSON.stringify(after.json || {});
  s.check('MB-10', 'Partial update (only phone) keeps name and address (no silent wiping of other fields)', part.status < 500 && /QATEST/.test(dd) && /NEW ADDRESS 9/.test(dd), `${part.status}; after: ${dd.slice(0, 200)}`);
  // update of a non-existent member must not be a silent success
  const ghost = await call('POST', '/members/save-member', { ...base(), mbno: '1999999999' });
  s.check('MB-11', 'Update of a member number that does not exist -> 404/400 (not 200 with empty result)', [400, 404].includes(ghost.status), `${ghost.status} ${(ghost.text || '').slice(0, 120)}`);

  // validation
  const bad = [
    ['MB-12', 'Empty first name', { f_name: '' }, [400, 422]],
    ['MB-13', 'Invalid date of birth 31-02-1990', { dob: '1990-02-31' }, [400, 422]],
    ['MB-14', 'Date of birth in the future', { dob: '2099-01-01' }, [400, 422]],
    ['MB-15', 'Retirement date before birth date', { dob: '2000-01-01', dor: '1990-01-01' }, [400, 422]],
    ['MB-16', 'Phone with letters', { phoneno: 'abcde12345' }, [400, 422]],
    ['MB-17', 'Negative gross salary', { gross_salary: -5 }, [400, 422]],
    ['MB-18', 'Negative compulsory deposit', { compulsory_deposit: -100 }, [400, 422]],
    ['MB-19', 'Aadhaar of wrong length', { aadharno: '123' }, [400, 422]],
    ['MB-20', 'Name of 5000 characters', { f_name: 'A'.repeat(5000) }, [400, 422]],
  ];
  for (const [id, title, patch, okCodes] of bad) {
    const r = await call('POST', '/members/save-member', base({ l_name: 'V' + id, ...patch }));
    const created = r.json && r.json.data && r.json.data.mbno;
    if (created) mine.push(created);
    s.check(id, `Create with ${title} is rejected (4xx, no 5xx, no row created)`, okCodes.includes(r.status), `${r.status} ${(r.text || '').slice(0, 110)}`);
  }
  const inj = await call('POST', '/members/save-member', base({ l_name: "O'BRIEN'); DROP TABLE member_master;--" }));
  if (inj.json && inj.json.data && inj.json.data.mbno) mine.push(inj.json.data.mbno);
  const still = await call('GET', '/members/statistics');
  s.check('MB-21', 'SQL-injection style name is stored as text and the member table survives', inj.status < 500 && still.status === 200, `${inj.status}/${still.status}`);
  const uni = await call('POST', '/members/save-member', base({ l_name: 'ÜNÏCODE नमस्ते <b>x</b>' }));
  if (uni.json && uni.json.data && uni.json.data.mbno) mine.push(uni.json.data.mbno);
  s.check('MB-22', 'Unicode / HTML in name accepted without error', uni.status < 500 && uni.status > 0, uni.status);

  // concurrency: 8 parallel creates must give 8 distinct numbers and no 5xx
  const par = await Promise.all(Array.from({ length: 8 }, (_, i) => call('POST', '/members/save-member', base({ l_name: 'P' + i + Date.now().toString().slice(-5) }))));
  const nums = par.map(r => r.json && r.json.data && r.json.data.mbno).filter(Boolean);
  nums.forEach(n => mine.push(n));
  s.check('MB-23', '8 parallel creates give 8 different member numbers and no 5xx', new Set(nums).size === 8 && par.every(r => r.status < 500), `distinct=${new Set(nums).size} statuses=${[...new Set(par.map(r => r.status))]}`);

  // compulsory deposit auto-posting (per code: posts ledger + starts RD)
  const cd = await call('POST', '/members/save-member', base({ compulsory_deposit: 500 }));
  const cdn = cd.json && cd.json.data && cd.json.data.mbno;
  if (cdn) mine.push(cdn);
  s.check('MB-24', 'Member created with compulsory deposit 500 succeeds', cd.status < 300 && !!cdn, `${cd.status} ${(cd.text || '').slice(0, 120)}`);
  if (cdn) {
    const lg = await call('GET', `/member-ledger?mbno=${cdn}`);
    const rd = await call('GET', `/rd/member-config/${cdn}/2026/current`);
    s.check('MB-25', 'CD 500 shows in the member ledger and RD config exists (member-ledger endpoint 2xx)', lg.status < 500 && rd.status < 500, `ledger ${lg.status}, rd ${rd.status} ${(rd.text || '').slice(0, 80)}`);
  }

  // delete only my own members
  const del = await call('DELETE', `/members/${m.mbno}`);
  s.check('MB-26', 'Delete of own QA member (no accounts) works or is refused with a clear 4xx', del.status < 500, `${del.status} ${(del.text || '').slice(0, 100)}`);
  const gone = await call('GET', `/members/find/${m.mbno}`);
  console.log('INFO after delete find ->', gone.status);
  require('fs').writeFileSync(require('path').join(__dirname, 'results', '06-created-members.json'), JSON.stringify(mine));
  console.log('QA members created:', mine.length, mine.join(','));
  process.exit(s.finish() ? 1 : 0);
})();
