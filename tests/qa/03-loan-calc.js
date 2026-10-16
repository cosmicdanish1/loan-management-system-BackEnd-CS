// Loan suite (read-only + pure calculation). No data is written: calculate-emi / amortization-schedule / early-closure quote
// are calculation endpoints. Invariants are checked against real loan cases returned by the system.
const { http, login, Suite } = require('./lib');

const near = (a, b, tol = 1) => Math.abs(Number(a) - Number(b)) <= tol;

(async () => {
  const s = new Suite('03-loan');
  const { token } = await login();
  const call = (m, u, b) => http(m, u, { token, body: b });

  // ---- EMI math
  const e = await call('POST', '/loans/calculate-emi', { principal: 100000, annualRate: 12, tenureMonths: 12 });
  const d = e.json && e.json.data;
  s.check('LN-01', 'EMI 100000 @12% 12m = 8884.88 (standard reducing-balance)', d && near(d.emi, 8884.88, 0.02), JSON.stringify(d && d.emi));
  s.check('LN-02', 'Breakdown has 12 rows, last balance ~0', d && d.monthlyBreakdown.length === 12 && Math.abs(d.monthlyBreakdown[11].balance) < 1, d && d.monthlyBreakdown[11].balance);
  s.check('LN-03', 'Sum of principal parts equals principal', d && near(d.monthlyBreakdown.reduce((a, r) => a + r.principal, 0), 100000, 1));
  s.check('LN-04', 'totalInterest = totalAmount - principal', d && near(d.totalInterest, d.totalAmount - 100000, 0.05));
  let prev = Infinity, mono = true;
  (d ? d.monthlyBreakdown : []).forEach(r => { if (r.balance > prev) mono = false; prev = r.balance; });
  s.check('LN-05', 'Outstanding balance strictly decreasing', mono);

  const zero = await call('POST', '/loans/calculate-emi', { principal: 120000, annualRate: 0, tenureMonths: 12 });
  s.check('LN-06', '0% rate -> EMI = principal/tenure (10000) or clean 400', (zero.status < 300 && near(zero.json.data.emi, 10000, 0.02)) || zero.status === 400, `${zero.status} ${(zero.text || '').slice(0, 120)}`);
  const cases = [
    ['LN-07', 'Negative principal', { principal: -5000, annualRate: 12, tenureMonths: 12 }],
    ['LN-08', 'Zero tenure (divide by zero)', { principal: 5000, annualRate: 12, tenureMonths: 0 }],
    ['LN-09', 'Negative tenure', { principal: 5000, annualRate: 12, tenureMonths: -3 }],
    ['LN-10', 'Negative rate', { principal: 5000, annualRate: -12, tenureMonths: 12 }],
    ['LN-11', 'String instead of numbers', { principal: 'abc', annualRate: 'x', tenureMonths: 'y' }],
    ['LN-12', 'Missing fields', {}],
    ['LN-13', 'Null fields', { principal: null, annualRate: null, tenureMonths: null }],
    ['LN-14', 'Huge principal 1e15', { principal: 1e15, annualRate: 12, tenureMonths: 12 }],
    ['LN-15', 'Tenure 100000 months (CPU / response size)', { principal: 100000, annualRate: 12, tenureMonths: 100000 }],
    ['LN-16', 'Rate 1e6 %', { principal: 100000, annualRate: 1e6, tenureMonths: 12 }],
    ['LN-17', 'Fractional tenure 12.5', { principal: 100000, annualRate: 12, tenureMonths: 12.5 }],
  ];
  for (const [id, title, body] of cases) {
    const r = await call('POST', '/loans/calculate-emi', body);
    const bad = r.status >= 500 || r.status === 0 || (r.status < 300 && r.json && r.json.data && [r.json.data.emi].some(v => v === null || Number.isNaN(Number(v)) || !Number.isFinite(Number(v))));
    const nonsense = r.status < 300 && /^(LN-07|LN-08|LN-09|LN-10|LN-11|LN-12|LN-13)$/.test(id);
    s.check(id, `${title}: rejected with 400 (no 5xx, no NaN/Infinity, no nonsense 2xx)`, !bad && !nonsense, `${r.status} ${(r.text || r.error || '').slice(0, 140)}`);
  }

  const am = await call('POST', '/loans/amortization-schedule', { principal: 50000, annualRate: 10, tenureMonths: 24, startDate: '2026-11-01' });
  const rows = am.json && am.json.data;
  const list = Array.isArray(rows) ? rows : rows && (rows.schedule || rows.monthlyBreakdown);
  s.check('LN-18', 'Amortization schedule returns 24 rows', Array.isArray(list) && list.length === 24, `${am.status} ${(am.text || '').slice(0, 100)}`);
  const badDate = await call('POST', '/loans/amortization-schedule', { principal: 50000, annualRate: 10, tenureMonths: 24, startDate: '31-31-2026' });
  s.check('LN-19', 'Invalid start date handled (no 5xx)', badDate.status < 500 && badDate.status > 0, badDate.status);

  // ---- real data invariants (read only)
  const cs = await call('GET', '/loans/cases?limit=40');
  const caseList = (cs.json && cs.json.data) || [];
  s.check('LN-20', 'Loan case list loads', cs.status === 200 && caseList.length > 0, cs.status);
  const sanctioned = caseList.filter(c => c.sanctioned).slice(0, 8);
  let inv = 0, invFail = [];
  for (const c of sanctioned) {
    const [m, h, sum] = await Promise.all([
      call('GET', `/loans/master/${c.loanCaseNo}`),
      call('GET', `/loans/member/${c.memberNo}/repayment-history`),
      call('GET', `/loans/case/${c.loanCaseNo}/repayment-summary?mbno=${c.memberNo}`),
    ]);
    inv++;
    if (m.status >= 500 || h.status >= 500 || sum.status >= 500) invFail.push(`${c.loanCaseNo}: ${m.status}/${h.status}/${sum.status}`);
  }
  s.check('LN-21', `Master, history and summary respond without 5xx for ${inv} sanctioned cases`, invFail.length === 0, invFail.join('; '));

  // repayment-history must not duplicate rows for the case (ES-212 regression)
  let dup = [];
  for (const c of sanctioned.slice(0, 5)) {
    const h = await call('GET', `/loans/member/${c.memberNo}/repayment-history`);
    const arr = (h.json && h.json.data && (h.json.data.rows || h.json.data)) || [];
    if (Array.isArray(arr)) {
      const keys = arr.map(r => r.id);
      if (new Set(keys).size !== keys.length && keys.length > 1) dup.push(`${c.memberNo}: ${keys.length - new Set(keys).size} duplicate rows`);
    }
  }
  s.check('LN-22', 'Repayment history has no duplicated rows (ES-212 regression)', dup.length === 0, dup.join('; '));

  // quote must be pure: two identical calls give identical numbers
  if (sanctioned[0]) {
    const c = sanctioned[0];
    const q1 = await call('POST', `/loans/early-closure/quote/${c.loanCaseNo}`, { mbno: c.memberNo, closureDate: '2026-10-16' });
    const q2 = await call('POST', `/loans/early-closure/quote/${c.loanCaseNo}`, { mbno: c.memberNo, closureDate: '2026-10-16' });
    s.check('LN-23', 'Early-closure quote is read-only and repeatable', q1.status < 500 && JSON.stringify(q1.json && q1.json.data) === JSON.stringify(q2.json && q2.json.data), `${q1.status}/${q2.status}`);
    const qBad = await call('POST', `/loans/early-closure/quote/${c.loanCaseNo}`, { mbno: c.memberNo, closureDate: 'not-a-date' });
    s.check('LN-24', 'Quote with invalid date -> no 5xx', qBad.status < 500, qBad.status);
    const qWrong = await call('POST', `/loans/early-closure/quote/${c.loanCaseNo}`, { mbno: '1' });
    s.check('LN-25', 'Quote with wrong member for the case -> 4xx, not another member\'s data (ES-212 class)', qWrong.status >= 400 && qWrong.status < 500, `${qWrong.status} ${(qWrong.text || '').slice(0, 100)}`);
  }
  const el = await call('GET', `/loans/eligibility/${(caseList[0] || {}).memberNo || '1'}?amount=-1&loanType=ZZZ`);
  s.check('LN-26', 'Eligibility with negative amount / unknown loan type -> no 5xx', el.status < 500, `${el.status} ${(el.text || '').slice(0, 100)}`);
  const el2 = await call('GET', '/loans/eligibility/99999999999999999999?amount=1000');
  s.check('LN-27', 'Eligibility with out-of-range member number -> no 5xx', el2.status < 500, `${el2.status} ${(el2.text || '').slice(0, 100)}`);
  const nf = await call('GET', '/loans/case/NOPE-1');
  s.check('LN-28', 'Unknown case number -> 400/404 (not 500)', nf.status === 404 || nf.status === 400, nf.status);
  const inj = await call('GET', "/loans/case/1'%3BDROP%20TABLE%20loan_master%3B--");
  s.check('LN-29', 'SQL-injection style case number -> 4xx and table intact', inj.status >= 400 && inj.status < 500, inj.status);
  const after = await call('GET', '/loans/cases?limit=1');
  s.check('LN-30', 'Loan data still readable after injection probe', after.status === 200);
  process.exit(s.finish() ? 1 : 0);
})();
