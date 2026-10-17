// Masters CRUD (cast category, designation, wing, office) on records this suite creates. Checks: duplicate keys never overwrite,
// editing one record never touches another, delete only of own records, delete-in-use protection (member references own QA wing/office).
const { http, login, Suite } = require('./lib');
const mem = (o) => ({ prefix: 'MR', f_name: 'QATEST', m_name: '', l_name: 'M' + Date.now().toString().slice(-6), sex: 'M', desig: 'CLERK', present_address: 'QA', permanent_address: 'QA', wingno: '1', officeno: 1, age: '30', dob: '1995-05-05', dor: '2035-05-05', gross_salary: 30000, basic_pay: 20000, nominee_name: 'QA', nominee_address: 'X', nominee_relation: 'X', declare_date: '2026-10-16', memb_date: '2026-10-16', flg_incometax: 'N', flg_insured: 'N', insureamt: 0, remarks: 'QA', dept_name: 'QA', isactive: 'Y', flg_retire: 'N', phoneno: '9000000004', fathers_name: 'QA', compulsory_deposit: 0, share_amount: 0, cast_category: '', ...o });
const arr = (r) => { const d = r.json && r.json.data; return Array.isArray(d) ? d : (d && (d.data || d.items)) || []; };

(async () => {
  const s = new Suite('12-masters');
  const { token } = await login();
  const call = (m, u, b) => http(m, u, { token, body: b });
  const t = Date.now().toString().slice(-6);

  // ----- cast category
  const id1 = 700000 + Number(t.slice(-4)), id2 = id1 + 1;
  const c1 = await call('POST', '/admin/cast-categories', { id: id1, name: 'QA CAST ONE' });
  const c2 = await call('POST', '/admin/cast-categories', { id: id2, name: 'QA CAST TWO' });
  s.check('MS-01', 'Create two QA cast categories', c1.status < 300 && c2.status < 300, `${c1.status}/${c2.status} ${(c1.text || '').slice(0, 100)}`);
  const dup = await call('POST', '/admin/cast-categories', { id: id1, name: 'OVERWRITE ATTEMPT' });
  const g1 = await call('GET', `/admin/cast-categories/${id1}`);
  s.check('MS-02', 'Duplicate id is refused (409/400) and does NOT overwrite the existing record', dup.status >= 400 && !/OVERWRITE/.test(JSON.stringify(g1.json)), `${dup.status}; record now ${JSON.stringify(g1.json && g1.json.data).slice(0, 100)}`);
  const long = await call('POST', '/admin/cast-categories', { id: id2 + 1, name: 'X'.repeat(31) });
  s.check('MS-03', 'Name longer than 30 chars -> 400', long.status === 400, long.status);
  const p = await call('PATCH', `/admin/cast-categories/${id1}`, { name: 'QA CAST ONE EDIT' });
  const g2 = await call('GET', `/admin/cast-categories/${id2}`);
  const g1b = await call('GET', `/admin/cast-categories/${id1}`);
  s.check('MS-04', 'Editing record 1 changes only record 1', /EDIT/.test(JSON.stringify(g1b.json)) && /QA CAST TWO/.test(JSON.stringify(g2.json)), `${p.status}`);
  const pn = await call('PATCH', '/admin/cast-categories/999999999', { name: 'x' });
  s.check('MS-05', 'Edit of a record that does not exist -> 404 (not 200)', pn.status === 404, pn.status);
  const d1 = await call('DELETE', `/admin/cast-categories/${id1}`);
  const d1b = await call('DELETE', `/admin/cast-categories/${id1}`);
  const d2 = await call('DELETE', `/admin/cast-categories/${id2}`);
  s.check('MS-06', 'Delete own records works; deleting again -> 404', d1.status < 300 && d2.status < 300 && d1b.status === 404, `${d1.status}/${d2.status}/${d1b.status}`);

  // ----- designation
  const code = 'QA' + t;
  const e1 = await call('POST', '/admin/designations', { code, name: 'QA DESIG', level: 1 });
  s.check('MS-07', 'Create QA designation', e1.status < 300, `${e1.status} ${(e1.text || '').slice(0, 100)}`);
  const e2 = await call('POST', '/admin/designations', { code, name: 'OVERWRITE' });
  const eg = await call('GET', `/admin/designations/${code}`);
  s.check('MS-08', 'Duplicate designation code refused and original unchanged', e2.status >= 400 && !/OVERWRITE/.test(JSON.stringify(eg.json)), `${e2.status}; ${JSON.stringify(eg.json && eg.json.data).slice(0, 100)}`);
  const e3 = await call('POST', '/admin/designations', { code: 'C'.repeat(21), name: 'x' });
  s.check('MS-09', 'Code longer than 20 chars -> 400', e3.status === 400, e3.status);
  const ed = await call('DELETE', `/admin/designations/${code}`);
  s.check('MS-10', 'Delete own designation works', ed.status < 300, `${ed.status}`);

  // ----- wing + member in use
  const wid = 'QW' + t.slice(-3);
  const w1 = await call('POST', '/admin/wings', { wingId: wid, wingName: 'QA WING', state: 'CG' });
  s.check('MS-11', 'Create QA wing', w1.status < 300, `${w1.status} ${(w1.text || '').slice(0, 100)}`);
  const w2 = await call('POST', '/admin/wings', { wingId: wid, wingName: 'OVERWRITE', state: 'XX' });
  const wg = await call('GET', `/admin/wings/${wid}`);
  s.check('MS-12', 'Duplicate wing id refused and original unchanged', w2.status >= 400 && !/OVERWRITE/.test(JSON.stringify(wg.json)), `${w2.status}; ${JSON.stringify(wg.json && wg.json.data).slice(0, 100)}`);
  const mk = await call('POST', '/members/save-member', mem({ wingno: wid }));
  s.check('MS-13', 'QA member created that uses the QA wing', mk.status < 300, mk.status);
  const wd = await call('DELETE', `/admin/wings/${wid}`);
  s.check('MS-14', 'Deleting a wing that a member uses is refused (4xx)', wd.status >= 400 && wd.status < 500, `${wd.status} ${(wd.text || '').slice(0, 100)}`);
  // ----- office
  const oid = 800000 + Number(t.slice(-4));
  const o1 = await call('POST', '/admin/offices', { officeId: oid, officeName: 'QA OFFICE', division: 'QA', address: 'QA', city: 'QA' });
  s.check('MS-15', 'Create QA office', o1.status < 300, `${o1.status} ${(o1.text || '').slice(0, 100)}`);
  const o2 = await call('POST', '/admin/offices', { officeId: oid, officeName: 'OVERWRITE' });
  const og = await call('GET', `/admin/offices/${oid}`);
  s.check('MS-16', 'Duplicate office id refused and original unchanged', o2.status >= 400 && !/OVERWRITE/.test(JSON.stringify(og.json)), `${o2.status}; ${JSON.stringify(og.json && og.json.data).slice(0, 100)}`);
  const mk2 = await call('POST', '/members/save-member', mem({ officeno: oid }));
  const od = await call('DELETE', `/admin/offices/${oid}`);
  s.check('MS-17', 'Deleting an office that a member uses is refused (4xx)', mk2.status < 300 && od.status >= 400 && od.status < 500, `member ${mk2.status}; delete ${od.status} ${(od.text || '').slice(0, 100)}`);
  const odn = await call('DELETE', '/admin/offices/999999999');
  s.check('MS-18', 'Delete of an office that does not exist -> 404', odn.status === 404, odn.status);
  const inj = await call('POST', '/admin/designations', { code: 'Q' + t, name: "x'); DROP TABLE designation_master;--" });
  const l = await call('GET', '/admin/designations');
  s.check('MS-19', 'SQL-injection style name stored as text, table intact', inj.status < 500 && l.status === 200, `${inj.status}/${l.status}`);
  await call('DELETE', `/admin/designations/Q${t}`);
  console.log('INFO leftovers: wing', wid, 'office', oid, '(in use by QA members, cannot be deleted by design)');
  process.exit(s.finish() ? 1 : 0);
})();
