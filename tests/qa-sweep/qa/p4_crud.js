const L = require('./lib');
const R = [];
const P = '/api/v1';
let token;
const chk = (res, name, ok, detail) => { R.push({ res, name, ok, detail: String(detail ?? '').slice(0, 240) }); if (!ok) console.log('FAIL', res, '|', name, '|', String(detail ?? '').slice(0, 160)); };
const data = (r) => r.json?.data?.data ?? r.json?.data ?? r.json;
const today = '2026-10-16';
const XSS = '<img src=x onerror=alert(1)>';
const RES = [
  { name: 'designations', base: '/admin/designations', key: 'QA9', mk: (k) => ({ code: k, name: 'QA Fake Desig', level: 3 }), upd: { name: 'QA Renamed' }, updField: 'name',
    bad: [{ code: 'QAB1', name: '', level: 3 }, { code: 'QAB2', name: 'x', level: -5 }, { code: 'Q'.repeat(300), name: 'x', level: 1 }, { code: 'QAB3', name: XSS, level: 1 }, { code: 'QAB4', name: 'x', level: 'abc' }] },
  { name: 'cast-categories', base: '/admin/cast-categories', key: 900001, mk: (k) => ({ id: k, name: 'QA Cat' }), upd: { name: 'QA Cat 2' }, updField: 'name',
    bad: [{ id: 900002, name: '' }, { id: -5, name: 'x' }, { id: 900003, name: 'x'.repeat(5000) }, { id: 'abc', name: 'x' }] },
  { name: 'offices', base: '/admin/offices', key: 900001, mk: (k) => ({ officeId: k, officeName: 'QA Office', division: 'QA', address: 'QA addr', city: 'QA city' }), upd: { officeName: 'QA Office 2' }, updField: 'officeName',
    bad: [{ officeId: 900002, officeName: '', division: '', address: '', city: '' }, { officeId: -1, officeName: 'x', division: 'x', address: 'x', city: 'x' }, { officeId: 900003, officeName: 'x'.repeat(5000), division: 'x', address: 'x', city: 'x' }] },
  { name: 'wings', base: '/admin/wings', key: 'QAW1', mk: (k) => ({ wingId: k, wingName: 'QA Wing', state: 'QA' }), upd: { wingName: 'QA Wing 2' }, updField: 'wingName',
    bad: [{ wingId: 'QAW2', wingName: '', state: '' }, { wingId: 123, wingName: 'x', state: 'x' }, { wingId: 'W'.repeat(400), wingName: 'x', state: 'x' }] },
  { name: 'admin-deposit-loan-slabs', base: '/admin/deposit-loan-slabs', idFrom: 'id', mk: () => ({ name: 'QA slab', type: 'fixed_deposit', minAmount: 1000, maxAmount: 5000, minTenure: 6, maxTenure: 12, interestRate: 7.5, isActive: true, effectiveFrom: today }), upd: { name: 'QA slab 2' }, updField: 'name', putUpd: false,
    bad: [{ name: 'x', type: 'fixed_deposit', minAmount: 5000, maxAmount: 1000, minTenure: 6, maxTenure: 12, interestRate: 7.5, isActive: true, effectiveFrom: today }, { name: 'x', type: 'fixed_deposit', minAmount: -1, maxAmount: 5, minTenure: 6, maxTenure: 12, interestRate: 500, isActive: true, effectiveFrom: today }, { name: 'x', type: 'bogus', minAmount: 1, maxAmount: 2, minTenure: 1, maxTenure: 2, interestRate: 1, isActive: true, effectiveFrom: 'notadate' }] },
  { name: 'config-deposit-slabs', base: '/admin/config/deposit-slabs', idFrom: 'id', mk: () => ({ name: 'QA dslab', type: 'recurring_deposit', minAmount: 100, maxAmount: 900, minTenure: 3, maxTenure: 6, interestRate: 6, isActive: true, effectiveFrom: today }), upd: { name: 'QA dslab 2' }, updField: 'name', putUpd: true,
    bad: [{ name: 'x', type: 'recurring_deposit', minAmount: 900, maxAmount: 100, minTenure: 3, maxTenure: 6, interestRate: -3, isActive: true, effectiveFrom: today }] },
  { name: 'config-interest-rates', base: '/admin/config/interest-rates', idFrom: 'id', mk: () => ({ name: 'QA rate', type: 'loan', rate: 9.5, calculationMethod: 'simple', isActive: true, effectiveFrom: today }), upd: { name: 'QA rate 2' }, updField: 'name', putUpd: true,
    bad: [{ name: 'x', type: 'loan', rate: -9, calculationMethod: 'simple', isActive: true, effectiveFrom: today }, { name: 'x', type: 'loan', rate: 99999, calculationMethod: 'simple', isActive: true, effectiveFrom: today }, { name: 'x', type: 'loan', rate: 5, calculationMethod: 'simple', isActive: true, effectiveFrom: today, effectiveTo: '2000-01-01' }] },
  { name: 'config-system', base: '/admin/config/system', idFrom: 'id', mk: () => ({ key: 'qa.fake.key.' + Date.now(), name: 'QA key', value: 'v', dataType: 'string', category: 'system_settings', isActive: true, isReadonly: false }), upd: { value: 'v2' }, updField: 'value', putUpd: true,
    bad: [{ key: '', name: '', value: '', dataType: 'bogus', category: '', isActive: true, isReadonly: false }] },
  { name: 'users', base: '/admin/users', idFrom: 'id', mk: () => ({ username: 'qa_fake_' + (Date.now() % 100000), email: 'qa' + Date.now() + '@example.test', password: 'QaFake@12345', firstName: 'QA', lastName: 'Fake', role: 'clerk', isActive: true }), upd: { firstName: 'QA2' }, updField: 'firstName', putUpd: true,
    bad: [{ username: 'x', email: 'notanemail', password: '1', firstName: '', lastName: '', role: 'clerk', isActive: true }, { username: 'qa_bad2', email: 'a@b.test', password: 'weak', firstName: 'a', lastName: 'b', role: 'superuser-bogus', isActive: true }] },
  { name: 'dashboard-notices', base: '/dashboard-notices', idFrom: 'id', mk: () => ({ title: 'QA notice', message: 'fake', type: 'info', postedBy: 'qa_admin' }), noGetOne: true,
    bad: [{}, { title: '', message: '', type: 'bogus', postedBy: '' }, { title: 'x'.repeat(10000), message: 'y', type: 'info', postedBy: 'q' }] },
];
async function life(r) {
  const call = (m, p, b) => L.call(m, P + p, { token, body: b });
  let key = r.key;
  const c1 = await call('POST', r.base, r.mk(key));
  chk(r.name, 'create 2xx', c1.status >= 200 && c1.status < 300, c1.status + ' ' + c1.text.slice(0, 120));
  if (c1.status >= 300) return;
  if (r.idFrom) key = data(c1)?.[r.idFrom];
  chk(r.name, 'create returns id/key', key !== undefined && key !== null, JSON.stringify(data(c1)).slice(0, 100));
  if (key == null) return;
  if (!r.noGetOne) { const one = await call('GET', `${r.base}/${key}`); chk(r.name, 'get-one 200 after create', one.status === 200, one.status); }
  const list = await call('GET', r.base); chk(r.name, 'list contains created', list.status === 200 && list.text.includes(String(key)), list.status);
  if (r.key !== undefined) {
    const d = await call('POST', r.base, { ...r.mk(key), [r.updField]: 'DUPLICATE-OVERWRITE' });
    const after = await call('GET', `${r.base}/${key}`);
    chk(r.name, 'duplicate create rejected (4xx) & original untouched', d.status >= 400 && d.status < 500 && !after.text.includes('DUPLICATE-OVERWRITE'), `dup status ${d.status}; overwritten=${after.text.includes('DUPLICATE-OVERWRITE')}`);
  } else if (r.name === 'config-system') {
    const d = await call('POST', r.base, { ...r.mk(), key: data(c1).key });
    chk(r.name, 'duplicate unique key rejected', d.status >= 400 && d.status < 500, d.status);
    if (d.status < 300) { const k2 = data(d)?.id; if (k2 != null) await call('DELETE', `${r.base}/${k2}`); }
  } else if (r.name === 'users') {
    const d = await call('POST', r.base, { ...r.mk(), username: data(c1).username });
    chk(r.name, 'duplicate username rejected', d.status >= 400 && d.status < 500, d.status);
    if (d.status < 300) { const k2 = data(d)?.id; if (k2 != null) await call('DELETE', `${r.base}/${k2}`); }
  }
  if (r.upd) {
    const u = await call(r.putUpd ? 'PUT' : 'PATCH', `${r.base}/${key}`, r.upd);
    chk(r.name, 'update 2xx', u.status < 300, u.status + ' ' + u.text.slice(0, 100));
    const g = await call('GET', `${r.base}/${key}`); chk(r.name, 'update persisted', g.status === 200 && g.text.includes(Object.values(r.upd)[0]), g.status);
    const un = await call(r.putUpd ? 'PUT' : 'PATCH', `${r.base}/${r.key !== undefined ? 'NOPE_999999' : 987654321}`, r.upd);
    chk(r.name, 'update nonexistent -> 404', un.status === 404, un.status + ' ' + un.text.slice(0, 80));
  }
  for (const [i, b] of r.bad.entries()) {
    const bd = await call('POST', r.base, b);
    chk(r.name, `invalid create #${i} rejected (4xx)`, bd.status >= 400 && bd.status < 500, bd.status + ' ' + JSON.stringify(b).slice(0, 90));
    if (bd.status < 300) { const k2 = r.key !== undefined ? (b.code ?? b.id ?? b.officeId ?? b.wingId) : data(bd)?.[r.idFrom]; if (k2 != null) await call('DELETE', `${r.base}/${k2}`); }
  }
  const dl = await call('DELETE', `${r.base}/${key}`); chk(r.name, 'delete 2xx', dl.status < 300, dl.status + ' ' + dl.text.slice(0, 100));
  if (!r.noGetOne) { const g2 = await call('GET', `${r.base}/${key}`); chk(r.name, 'get after delete -> 404', g2.status === 404, g2.status); }
  else { const l2 = await call('GET', r.base); chk(r.name, 'gone from list after delete', !l2.text.includes(`"id":${key},`), l2.status); }
  const dl2 = await call('DELETE', `${r.base}/${key}`); chk(r.name, 'delete again -> 404', dl2.status === 404, dl2.status + ' ' + dl2.text.slice(0, 80));
}
(async () => {
  token = (await L.login()).token;
  for (const r of RES) { try { await life(r); } catch (e) { chk(r.name, 'runner exception', false, e.message); } }
  L.save('p4_crud.json', R);
  console.log('checks', R.length, 'failed', R.filter(x => !x.ok).length);
})();
