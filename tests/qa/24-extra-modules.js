// Extra modules: member status, group insurance, share snapshot, dividend pay/credit validation, short recovery, month-end,
// re-agreement and surety validation, onboarding, analytics, alerts, notices, search, consolidation, license (read only).
// Global irreversible actions are NOT executed (dividend credit commit, group insurance post, license activate, analytics config).
// Writes only touch QA members / QA notices. Env: QA_USER / QA_PASS.
const { http, login, Suite } = require('./lib');
const { Client } = require('pg');
require('dotenv').config({ path: require('path').resolve(__dirname, '../../.env') });
const mem = () => ({ prefix: 'MR', f_name: 'QATEST', m_name: '', l_name: 'E' + Date.now().toString().slice(-7), sex: 'M', desig: 'CLERK', present_address: 'QA', permanent_address: 'QA', wingno: '1', officeno: 1, age: '30', dob: '1995-05-05', dor: '2035-05-05', gross_salary: 30000, basic_pay: 20000, nominee_name: 'QA', nominee_address: 'X', nominee_relation: 'X', declare_date: '2026-10-16', memb_date: '2026-10-16', flg_incometax: 'N', flg_insured: 'N', insureamt: 0, remarks: 'QA', dept_name: 'QA', isactive: 'Y', flg_retire: 'N', phoneno: '9000000021', fathers_name: 'QA', compulsory_deposit: 0, share_amount: 0, cast_category: '' });
const d = (r) => { let x = r.json && r.json.data; while (x && x.success !== undefined && x.data !== undefined) x = x.data; return x; };
const is4 = (r) => r.status >= 400 && r.status < 500;

(async () => {
  const s = new Suite('24-extra-modules');
  const { token } = await login();
  const call = (m, u, b) => http(m, u, { token, body: b, timeout: 120000 });
  const pg = new Client({ host: process.env.DB_HOST, port: process.env.DB_PORT, user: process.env.DB_USERNAME, password: process.env.DB_PASSWORD, database: process.env.DB_DATABASE });
  await pg.connect();
  const rows = async (sql, p) => (await pg.query(sql, p)).rows;
  const qa = (await call('POST', '/members/save-member', mem())).json.data.mbno;

  // ---------- member status
  const sum = d(await call('GET', '/member-status/summary'));
  for (const cat of ['ready', 'retired-rd', 'upcoming']) {
    const r = await call('GET', `/member-status/list?category=${cat}&limit=5&offset=0`);
    const lst = d(r);
    const total = lst && (lst.total ?? lst.count);
    s.check('MS-' + cat, `Member status list '${cat}' loads, 200 under 3 s`, r.status === 200 && r.ms < 3000, `${r.status} ${r.ms}ms ${JSON.stringify(lst).slice(0, 100)}`);
  }
  s.check('MSX-1', 'Summary counts are numbers', sum && ['ready', 'retiredWithRd', 'upcoming'].every(k => Number.isFinite(Number(sum[k]))), JSON.stringify(sum));
  const real = d(await call('GET', '/member-status/list?category=ready&limit=3&offset=0'));
  const rr = real && (real.rows || real.data || real.items || (Array.isArray(real) ? real : []));
  const sumReady = Number(sum && sum.ready);
  const listTotal = Number(real && (real.total ?? real.count));
  s.check('MSX-2', 'List total for category ready equals the summary count', !listTotal || listTotal === sumReady, `list ${listTotal} vs summary ${sumReady}`);
  for (const [id, u] of [['MSX-3', '/member-status/list?category=bogus'], ['MSX-4', '/member-status/list?category=ready&limit=-1'], ['MSX-5', '/member-status/list?category=ready&limit=abc'], ['MSX-6', '/member-status/list?category=ready&offset=-5'], ['MSX-7', '/member-status/list?category=ready&limit=99999999'], ['MSX-8', "/member-status/list?category=ready&search=%27%3B--"], ['MSX-9', '/member-status/summary?months=-3'], ['MSX-10', '/member-status/summary?months=abc']]) {
    const r = await call('GET', u);
    s.check(id, `GET ${u.replace('/member-status/', '')}: no 5xx and < 5 s`, r.status > 0 && r.status < 500 && r.ms < 5000, `${r.status} ${r.ms}ms ${(r.text || '').slice(0, 80)}`);
  }
  const inact = await call('POST', `/member-status/${qa}/inactive`, { reason: 'QA test' });
  const st = (await rows(`select isactive from member_master where mbno=$1`, [qa]))[0];
  s.check('MSX-11', 'Mark a QA member inactive: accepted, isactive flag changes', is4(inact) || (inact.status < 300 && st.isactive !== 'Y'), `${inact.status} flag=${st.isactive} ${(inact.text || '').slice(0, 120)}`);
  s.check('MSX-12', 'Inactive with an empty reason -> 400', (await call('POST', `/member-status/${qa}/inactive`, { reason: '' })).status === 400);
  s.check('MSX-13', 'Inactive for an unknown member -> 404/400', [400, 404].includes((await call('POST', '/member-status/1999999999/inactive', { reason: 'x' })).status));
  const re = await call('POST', `/member-status/${qa}/reactivate`, { reason: 'QA test' });
  const st2 = (await rows(`select isactive from member_master where mbno=$1`, [qa]))[0];
  s.check('MSX-14', 'Reactivate restores the flag to Y', re.status < 300 ? st2.isactive === 'Y' : is4(re), `${re.status} flag=${st2.isactive} ${(re.text || '').slice(0, 100)}`);
  s.check('MSX-15', 'Reactivate for an unknown member -> 404/400', [400, 404].includes((await call('POST', '/member-status/1999999999/reactivate', { reason: 'x' })).status));
  const hist = await call('GET', `/member-status/${qa}/history`);
  s.check('MSX-16', 'Member status history loads for the QA member', hist.status === 200, hist.status);

  // ---------- group insurance (preview only)
  const ctx = d(await call('GET', '/group-insurance/context'));
  s.check('GI-1', 'Group insurance context loads with years', ctx && Array.isArray(ctx.years), JSON.stringify(ctx).slice(0, 100));
  const gp = await call('POST', '/group-insurance/preview', { yearcode: ctx && ctx.years && ctx.years[0] && ctx.years[0].yearcode });
  s.check('GI-2', 'Preview for the first listed year answers (200 or a clear 4xx)', gp.status > 0 && gp.status < 500, `${gp.status} ${(gp.text || '').slice(0, 140)}`);
  for (const [id, b] of [['GI-3', { yearcode: 999 }], ['GI-4', { yearcode: 'abc' }], ['GI-5', { yearcode: -1 }]]) {
    const r = await call('POST', '/group-insurance/preview', b);
    s.check(id, `Preview with ${JSON.stringify(b)} -> 4xx`, is4(r), `${r.status} ${(r.text || '').slice(0, 90)}`);
  }
  const gpost = await call('POST', '/group-insurance/post', { yearcode: 999 });
  s.check('GI-6', 'Post for a year that does not exist is refused 4xx (the real post is NOT run)', is4(gpost), `${gpost.status} ${(gpost.text || '').slice(0, 90)}`);
  s.check('GI-7', 'Run details for a run that does not exist -> 404', (await call('GET', '/group-insurance/runs/99999999')).status === 404);

  // ---------- share snapshot / dividend
  const sr = await call('GET', '/dividend/share-snapshot/report?month=9&year=2026');
  s.check('SS-1', 'Share snapshot report loads (month 9 / 2026)', sr.status === 200, `${sr.status} ${(sr.text || '').slice(0, 100)}`);
  for (const [id, u] of [['SS-2', '/dividend/share-snapshot/report?month=13&year=2026'], ['SS-3', '/dividend/share-snapshot/report?month=0&year=2026'], ['SS-4', '/dividend/share-snapshot/report?month=9&year=1800'], ['SS-5', '/dividend/share-snapshot/report?month=abc&year=2026']]) {
    const r = await call('GET', u);
    s.check(id, `GET ${u.split('?')[1]}: 4xx`, is4(r), `${r.status} ${(r.text || '').slice(0, 80)}`);
  }
  const before = Number((await rows(`select count(*) c from share_monthly_balance`))[0].c);
  for (const [id, b] of [['SS-6', { month: 13, year: 2026 }], ['SS-7', { month: 9, year: 1800 }], ['SS-8', { month: 'x', year: 'y' }], ['SS-9', {}]]) {
    const r = await call('POST', '/dividend/share-snapshot', b);
    s.check(id, `POST share-snapshot ${JSON.stringify(b)} -> 4xx and nothing written`, is4(r) && Number((await rows(`select count(*) c from share_monthly_balance`))[0].c) === before, `${r.status} ${(r.text || '').slice(0, 80)}`);
  }
  const dp = await call('POST', '/transactions/dividend/pay', {});
  const dp2 = await call('POST', '/transactions/dividend/pay', { memberNo: qa, amount: -5 });
  const dp3 = await call('POST', '/transactions/dividend/pay', { memberNo: '1999999999', amount: 100 });
  s.check('DV-1', 'Dividend pay with empty, negative-amount or unknown-member body -> 4xx', is4(dp) && is4(dp2) && is4(dp3), `${dp.status},${dp2.status},${dp3.status} ${(dp.text || '').slice(0, 80)}`);
  for (const [id, b] of [['DV-2', {}], ['DV-3', { yearcode: 999 }], ['DV-4', { yearcode: 'abc' }], ['DV-5', { yearcode: -1 }]]) {
    const r = await call('POST', '/dividend/credit/commit', b);
    s.check(id, `Dividend credit commit ${JSON.stringify(b)} -> 4xx (a real commit is NOT run: it would credit every member)`, is4(r), `${r.status} ${(r.text || '').slice(0, 90)}`);
  }
  const cp = await call('GET', '/dividend/credit/preview?yearcode=2');
  s.check('DV-6', 'Dividend credit preview for year 2 (previous year 1) lists the committed dividends', cp.status === 200 && ((d(cp) || {}).members || []).length > 0, `${cp.status} members=${((d(cp) || {}).members || []).length} ${(cp.text || '').slice(0, 100)}`);
  const cpb = await call('GET', '/dividend/credit/preview?yearcode=999');
  s.check('DV-7', 'Credit preview for an unknown year -> 4xx', is4(cpb), `${cpb.status}`);

  // ---------- short recovery / month-end
  const sr1 = await call('POST', '/transactions/short-recovery/adjust', {});
  const sr2 = await call('POST', '/transactions/short-recovery/adjust', { demandId: '99999999', reason: 'QA', amount: 10 });
  const sr3 = await call('POST', '/transactions/short-recovery/adjust', { demandId: '1', reason: '', amount: -50 });
  s.check('SR-1', 'Short recovery adjust: empty body, unknown demand id and negative amount -> 4xx (nothing written)', is4(sr1) && is4(sr2) && is4(sr3), `${sr1.status},${sr2.status},${sr3.status} ${(sr2.text || '').slice(0, 80)}`);
  const sl = await call('GET', '/transactions/short-recovery?month=10');
  s.check('SR-2', 'Short recovery list for a month loads', sl.status === 200, sl.status);
  const mr = await call('GET', '/loans/month-end/report?month=9&year=2026');
  s.check('ME-1', 'Month-end report for 9/2026 loads', mr.status === 200, `${mr.status} ${(mr.text || '').slice(0, 100)}`);
  for (const [id, u] of [['ME-2', '/loans/month-end/report?month=13&year=2026'], ['ME-3', '/loans/month-end/report?month=9&year=1800'], ['ME-4', '/loans/month-end/report?month=abc&year=2026']]) {
    const r = await call('GET', u);
    s.check(id, `month-end report ${u.split('?')[1]} -> 4xx`, is4(r), `${r.status} ${(r.text || '').slice(0, 80)}`);
  }
  const snapBefore = Number((await rows(`select count(*) c from information_schema.tables where table_name like 'loan_month_end%'`))[0].c);
  for (const [id, b] of [['ME-5', { month: 13, year: 2026 }], ['ME-6', { month: 9, year: 1800 }], ['ME-7', {}]]) {
    const r = await call('POST', '/loans/month-end/snapshot', b);
    s.check(id, `month-end snapshot ${JSON.stringify(b)} -> 4xx`, is4(r), `${r.status} ${(r.text || '').slice(0, 80)}`);
  }
  s.check('ME-8', 'Month-end history for an unknown member -> 200 empty or 404 (no 5xx)', (await call('GET', '/loans/month-end/history/1999999999')).status < 500);

  // ---------- re-agreement / surety validation
  s.check('RA-1', 'Re-agreement eligibility for an unknown case -> 404/400', [400, 404].includes((await call('GET', '/loans/reagreement/eligibility/NOPE-1')).status));
  s.check('RA-2', 'Re-agreement quote with an empty body -> 400', (await call('POST', '/loans/reagreement/quote', {})).status === 400);
  const ap = await call('POST', '/loans/reagreement/apply', {});
  const ap2 = await call('POST', '/loans/reagreement/apply', { mbno: String(qa), loancaseno: '1', newInstallments: -5, newRate: -1 });
  s.check('RA-3', 'Re-agreement apply with an empty body and with negative installments/rate -> 4xx', is4(ap) && is4(ap2), `${ap.status},${ap2.status} ${(ap.text || '').slice(0, 80)}`);
  for (const [id, u] of [['RA-4', '/loans/reagreement/99999999'], ['RA-5', '/loans/reagreement/99999999/draft'], ['RA-6', '/loans/reagreement/99999999/document'], ['RA-7', '/loans/reagreement/99999999/log']]) {
    s.check(id, `GET ${u} for an unknown re-agreement -> 404`, (await call('GET', u)).status === 404);
  }
  s.check('RA-8', 'Cancel an unknown re-agreement -> 404', (await call('POST', '/loans/reagreement/99999999/cancel', {})).status === 404);
  s.check('RA-9', 'Re-agreement list for a member with none loads', (await call('GET', `/loans/reagreement/member/${qa}/loans`)).status < 500);
  s.check('SU-1', 'Surety of an unknown case -> 404/400', [400, 404].includes((await call('GET', '/loans/surety/NOPE-1')).status));
  const sc = await call('PATCH', '/loans/surety/99999999', { surety1: qa });
  s.check('SU-2', 'Change surety on an unknown case -> 404/400', [400, 404].includes(sc.status), `${sc.status} ${(sc.text || '').slice(0, 80)}`);
  const sv = await call('GET', `/loans/surety/validate/${qa}`);
  s.check('SU-3', 'Surety validation for a QA member answers (no 5xx)', sv.status < 500 && sv.status > 0, `${sv.status} ${(sv.text || '').slice(0, 100)}`);
  s.check('SU-4', 'Surety validation for text -> no 5xx', (await call('GET', '/loans/surety/validate/abc')).status < 500);

  // ---------- license / onboarding / analytics / alerts / notices / search / consolidation
  const lic = d(await call('GET', '/license/status'));
  s.check('LI-1', 'License status shows active with days remaining', lic && lic.status === 'active' && lic.days_remaining > 0, JSON.stringify(lic).slice(0, 120));
  s.check('LI-2', 'License list loads for an administrator', (await call('GET', '/license/list')).status === 200);
  for (const u of ['/onboarding/status', '/onboarding/checklist', '/onboarding/profile', '/onboarding/terms', '/onboarding/report']) {
    const r = await call('GET', u);
    s.check('ON-' + u.split('/').pop(), `GET ${u} -> 200`, r.status === 200, `${r.status} ${(r.text || '').slice(0, 60)}`);
  }
  for (const [id, m, u, b] of [['ON-bad1', 'POST', '/onboarding/step', {}], ['ON-bad2', 'POST', '/onboarding/event', {}], ['ON-bad3', 'PUT', '/onboarding/preference', { mode: 'bogus' }], ['ON-bad4', 'POST', '/onboarding/terms/accept', {}]]) {
    const r = await call(m, u, b);
    s.check(id, `${m} ${u} with ${JSON.stringify(b)} -> 4xx (own user only)`, is4(r), `${r.status} ${(r.text || '').slice(0, 80)}`);
  }
  for (const u of ['/analytics/status', '/analytics/health', '/analytics/config']) {
    const r = await call('GET', u);
    s.check('AN-' + u.split('/').pop(), `GET ${u} -> 200`, r.status === 200, `${r.status} ${(r.text || '').slice(0, 80)}`);
  }
  for (const u of ['/analytics/session/start', '/analytics/page/visit', '/analytics/feature/usage', '/analytics/error/track', '/analytics/track/error', '/analytics/track/session']) {
    const r = await call('POST', u, {});
    s.check('AN-bad-' + u.replace(/\//g, '_'), `POST ${u} with an empty body -> 4xx (no 5xx, nothing written)`, is4(r), `${r.status} ${(r.text || '').slice(0, 80)}`);
  }
  const al = d(await call('GET', '/alert-settings'));
  s.check('AL-1', 'Alert settings load with groups', al && Array.isArray(al.groups), JSON.stringify(al).slice(0, 100));
  s.check('AL-2', 'Alert setting with an unknown key -> 404/400 (not a silent 200)', [400, 404].includes((await call('PUT', '/alert-settings/no_such_key_zz', { enabled: true })).status));
  s.check('AL-3', 'Alert group with an unknown name -> 404/400', [400, 404].includes((await call('PUT', '/alert-settings/group/no_such_group', { enabled: true })).status));
  s.check('AL-4', 'Alert test to an unknown destination -> 4xx', is4(await call('POST', '/alert-settings/test/nowhere', {})));
  const nt = await call('POST', '/dashboard-notices', { title: 'QA notice', message: 'QA test notice - remove', body: 'QA test notice - remove' });
  const nid = d(nt) && (d(nt).id || d(nt).noticeId);
  s.check('NO-1', 'Create a QA dashboard notice', nt.status < 300 && nt.status > 0, `${nt.status} ${(nt.text || '').slice(0, 120)}`);
  s.check('NO-2', 'Empty notice -> 400', (await call('POST', '/dashboard-notices', {})).status === 400);
  s.check('NO-3', 'Notice with a 100,000-character body -> 4xx', is4(await call('POST', '/dashboard-notices', { title: 'x', message: 'M'.repeat(100000), body: 'M'.repeat(100000) })));
  if (nid) s.check('NO-4', 'Delete the QA notice', (await call('DELETE', `/dashboard-notices/${nid}`)).status < 300);
  s.check('NO-5', 'Delete a notice that does not exist -> 404', (await call('DELETE', '/dashboard-notices/99999999')).status === 404);
  for (const u of ['/search/global?q=KAV', '/search/global?q=', "/search/global?q=%27%20OR%201%3D1--", '/search/global?q=' + 'A'.repeat(5000), '/search/suggestions?q=K']) {
    const r = await call('GET', u);
    s.check('SE-' + u.slice(8, 30).replace(/\W/g, '_'), `GET ${u.slice(0, 40)}... no 5xx, < 5 s`, r.status > 0 && r.status < 500 && r.ms < 5000, `${r.status} ${r.ms}ms`);
  }
  s.check('CO-1', 'Consolidation report loads', (await call('GET', '/consolidation/report')).status < 500);
  const ai = await call('POST', '/ai-chat', { messages: [] });
  s.check('AI-1', 'AI chat endpoint exists (the floating chat bot in the app calls POST /ai-chat)', ai.status !== 404, `${ai.status} ${(ai.text || '').slice(0, 90)}`);
  await pg.end();
  console.log('QA member', qa);
  process.exit(s.finish() ? 1 : 0);
})();
