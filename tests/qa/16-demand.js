// Demand generate + Excel import. Uses future months (JAN/FEB/MAR 2031) so no real month is touched, and memberNos filters so only
// chosen members are included. Env: QA_USER / QA_PASS.
const { http, login, Suite, BASE } = require('./lib');
const { Client } = require('pg');
require('dotenv').config({ path: require('path').resolve(__dirname, '../../.env') });
const XLSX = require(require('path').resolve(__dirname, '../../node_modules/xlsx'));

const sheetBuf = (rows) => { const ws = XLSX.utils.aoa_to_sheet(rows); const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, ws, 'Sheet1'); return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }); };
async function upload(token, buf, name, fields = {}) {
  const fd = new FormData();
  fd.append('file', new Blob([buf]), name);
  Object.entries(fields).forEach(([k, v]) => fd.append(k, v));
  const t0 = Date.now();
  try {
    const r = await fetch(BASE + '/transactions/demand-generation/import-preview', { method: 'POST', headers: { Authorization: 'Bearer ' + token }, body: fd, signal: AbortSignal.timeout(120000) });
    const text = await r.text(); let json; try { json = JSON.parse(text); } catch { }
    return { status: r.status, json, text: text.slice(0, 500), ms: Date.now() - t0 };
  } catch (e) { return { status: 0, text: String(e), ms: Date.now() - t0 }; }
}

(async () => {
  const s = new Suite('16-demand');
  const { token } = await login();
  const call = (m, u, b) => http(m, u, { token, body: b, timeout: 300000 });
  const pg = new Client({ host: process.env.DB_HOST, port: process.env.DB_PORT, user: process.env.DB_USERNAME, password: process.env.DB_PASSWORD, database: process.env.DB_DATABASE });
  await pg.connect();
  const rows = async (sql, p) => (await pg.query(sql, p)).rows;
  const real = (await rows(`select m.mbno, sum(l.instal_amt) emi from loan_master l join member_master m on m.mbno=l.mbno where l.balance>0 and m.mbno between 610000000 and 619999999 and coalesce(m.isactive,'Y')<>'N' group by m.mbno order by emi desc limit 1`))[0];
  s.check('DM-00', 'Found a real member with a running loan to generate against', !!real, JSON.stringify(real));
  const G = (month, year, extra = {}) => call('POST', '/transactions/demand-generation/generate', { month, year, memberNos: [Number(real.mbno)], ...extra });

  const bad1 = await G('XYZ', '2031');
  s.check('DM-01', 'Generate with an invalid month -> 400 (not 500)', bad1.status === 400, `${bad1.status} ${(bad1.text || '').slice(0, 100)}`);
  const bad2 = await G('JAN', 'abcd');
  s.check('DM-02', 'Generate with a non-numeric year -> 400', bad2.status === 400, `${bad2.status}`);
  const bad3 = await G('JAN', '1800');
  s.check('DM-03', 'Generate for year 1800 is refused (no silly periods)', bad3.status >= 400, `${bad3.status} ${(bad3.text || '').slice(0, 100)}`);
  const none = await call('POST', '/transactions/demand-generation/generate', { month: 'JAN', year: '2031', memberNos: ['abc'] });
  s.check('DM-04', 'Generate with a non-numeric member list does not 5xx', none.status > 0 && none.status < 500, `${none.status} ${(none.text || '').slice(0, 100)}`);
  const cnt0 = (await rows(`select count(*) c from demand_master where demand_for_year=2031`))[0].c;
  s.check('DM-05', 'Refused requests created no rows', Number(cnt0) === 0, cnt0);

  const g1 = await G('JAN', '2031');
  s.check('DM-06', 'Generate JAN 2031 for the chosen member succeeds', g1.status > 0 && g1.status < 300, `${g1.status} ${(g1.text || '').slice(0, 160)}`);
  const dm = await rows(`select mbno, totaldemand, rln_installment_amount, passflag from demand_master where demand_for_year=2031 and demand_for_month=1`);
  s.check('DM-07', 'Exactly one demand row, equal to the sum of the member EMIs', dm.length === 1 && Math.abs(Number(dm[0].totaldemand) - Number(real.emi)) < 0.01, `rows ${dm.length}; ${JSON.stringify(dm[0])} vs EMI sum ${real.emi}`);
  const g2 = await G('JAN', '2031');
  const dm2 = await rows(`select count(*) c from demand_master where demand_for_year=2031 and demand_for_month=1`);
  s.check('DM-08', 'Repeating the same month does not create more rows (skipped message)', Number(dm2[0].c) === 1 && g2.status < 300, `${g2.status} rows ${dm2[0].c} ${(g2.text || '').slice(0, 120)}`);
  const par = await Promise.all([G('FEB', '2031'), G('FEB', '2031'), G('FEB', '2031')]);
  const dm3 = await rows(`select count(*) c from demand_master where demand_for_year=2031 and demand_for_month=2`);
  s.check('DM-09', '3 simultaneous generate requests for the same month give one set of rows', Number(dm3[0].c) === 1 && par.every(r => r.status < 500), `rows ${dm3[0].c}; ${par.map(r => r.status)}`);

  // ---- import preview
  const H = ['S.NO', 'YYMM', 'CODE', 'MS.NO', 'PS.NO', 'NAME', 'TOTAL', 'R/D', 'R/LOAN', 'E/LOAN', 'INTT'];
  const qa = (await rows(`select mbno from member_master where f_name='QATEST' order by mbno desc limit 2`)).map(r => String(r.mbno));
  const row = (n, mb, total, rd, rln, aln, intt) => [n, '3103', 'X', mb, '', 'QA', total, rd, rln, aln, intt];
  const good = await upload(token, sheetBuf([H, row(1, qa[0], 1200, 200, 800, 0, 200), row(2, qa[1], 500, 0, 400, 0, 100)]), 'good.xlsx', { month: 'MAR', year: '2031' });
  s.check('DM-10', 'Preview of a valid file: 2 valid rows', good.status < 300 && good.json && good.json.data && good.json.data.summary.valid === 2, `${good.status} ${good.text.slice(0, 200)}`);
  const mixed = await upload(token, sheetBuf([H, row(1, qa[0], 1200, 200, 800, 0, 200), row(2, qa[0], 100, 0, 100, 0, 0), row(3, '1999999999', 100, 0, 100, 0, 0), row(4, qa[1], 700, 0, -500, 0, 200), row(5, qa[1], 'abc', 'x', 'y', 0, 0), row(6, qa[1], 999, 0, 400, 0, 100), row(7, '', 100, 0, 100, 0, 0)]), 'mixed.xlsx', { month: 'MAR', year: '2031' });
  const sm = mixed.json && mixed.json.data && mixed.json.data.summary;
  s.check('DM-11', 'Mixed file: 1 valid; duplicate, unknown member, negative, text, total mismatch and blank member are errors', sm && sm.valid === 1 && sm.errors === 6, `${mixed.status} ${JSON.stringify(sm)}`);
  const nohdr = await upload(token, sheetBuf([['A', 'B'], [1, 2]]), 'nohdr.xlsx', { month: 'MAR', year: '2031' });
  s.check('DM-12', 'File without the member column -> 400 with a clear message', nohdr.status === 400, `${nohdr.status} ${nohdr.text.slice(0, 120)}`);
  const empty = await upload(token, sheetBuf([H]), 'empty.xlsx', { month: 'MAR', year: '2031' });
  s.check('DM-13', 'File with only a header -> 400', empty.status === 400, `${empty.status} ${empty.text.slice(0, 120)}`);
  const txt = await upload(token, Buffer.from('this is not a spreadsheet'), 'fake.xlsx', { month: 'MAR', year: '2031' });
  s.check('DM-14', 'Text renamed to .xlsx -> 400, no fake preview', txt.status === 400 || (txt.json && txt.json.data && txt.json.data.summary.valid === 0), `${txt.status} ${txt.text.slice(0, 140)}`);
  const exe = await upload(token, Buffer.from('MZ\x90\x00'), 'virus.exe', { month: 'MAR', year: '2031' });
  s.check('DM-15', 'Executable file is refused', exe.status >= 400 && exe.status < 500, `${exe.status} ${exe.text.slice(0, 100)}`);
  const noFile = await call('POST', '/transactions/demand-generation/import-preview', {});
  s.check('DM-16', 'Preview with no file -> 400', noFile.status === 400, noFile.status);
  const bigRows = [H]; for (let i = 0; i < 5000; i++) bigRows.push(row(i, qa[0] + '', 100, 0, 100, 0, 0));
  const big = await upload(token, sheetBuf(bigRows), 'big.xlsx', { month: 'MAR', year: '2031' });
  s.check('DM-17', '5,000-row file previews in under 20 s without 5xx', big.status < 500 && big.status > 0 && big.ms < 20000, `${big.status} ${big.ms}ms`);

  // ---- import process
  const pr = good.json && good.json.data && good.json.data.rows;
  const proc = (data) => call('POST', '/transactions/demand-generation/import-process', { month: 'MAR', year: '2031', data });
  const badProc = [await call('POST', '/transactions/demand-generation/import-process', { month: 'XXX', year: '2031', data: pr }), await call('POST', '/transactions/demand-generation/import-process', { month: 'MAR', year: 'zz', data: pr })];
  s.check('DM-18', 'Process with invalid month / year -> 400', badProc.every(r => r.status === 400), badProc.map(r => r.status).join(','));
  const forged = await proc([{ key: 'x', memberId: '1999999999', memberName: 'GHOST', department: 'x', rlnAmount: 100, alnAmount: 0, rdAmount: 0, interest: 0, totalDemand: 100, fileTotal: 100, status: 'Valid', remarks: '' }]);
  const ghost = await rows(`select count(*) c from demand_master where mbno=1999999999`);
  s.check('DM-19', 'Process with a forged row for a member that does not exist saves nothing (no 5xx)', Number(ghost[0].c) === 0 && forged.status < 500, `${forged.status} ${(forged.text || '').slice(0, 140)} rows ${ghost[0].c}`);
  const neg = await proc([{ ...pr[0], rlnAmount: -800, totalDemand: -800 }]);
  s.check('DM-20', 'Process with a negative amount row skips it', neg.json && neg.json.recordCount === 0, `${neg.status} ${(neg.text || '').slice(0, 140)}`);
  const p1 = await proc(pr);
  const c1 = (await rows(`select count(*) c from demand_master where demand_for_year=2031 and demand_for_month=3`))[0].c;
  s.check('DM-21', 'Process the valid preview: 2 rows saved', p1.status < 300 && Number(c1) === 2, `${p1.status} rows ${c1} ${(p1.text || '').slice(0, 120)}`);
  const p2 = await proc(pr);
  const c2 = (await rows(`select count(*) c from demand_master where demand_for_year=2031 and demand_for_month=3`))[0].c;
  s.check('DM-22', 'Importing the same file twice for the same month does not create duplicate demand rows', Number(c2) === 2, `rows ${c1} -> ${c2}; ${p2.status} ${(p2.text || '').slice(0, 120)}`);
  const par2 = await Promise.all([proc(pr), proc(pr)]);
  const c3 = (await rows(`select count(*) c from demand_master where demand_for_year=2031 and demand_for_month=3`))[0].c;
  s.check('DM-23', 'Two simultaneous imports do not duplicate rows', Number(c3) === 2, `rows ${c3}; ${par2.map(r => r.status)}`);
  const dupSerial = await rows(`select dmnd_srno, count(*) c from demand_master group by 1 having count(*)>1 limit 3`);
  s.check('DM-24', 'Demand serial numbers are unique across the table', dupSerial.length === 0, JSON.stringify(dupSerial));
  // report on the generated month
  const rep = await call('POST', '/transactions/reports/demand-list/generate', { month: 'JAN', year: '2031' });
  s.check('DM-25', 'Demand list report for JAN 2031 loads and shows the member', rep.status < 300 && JSON.stringify(rep.json || '').includes(String(real.mbno)), `${rep.status} ${(rep.text || '').slice(0, 140)}`);
  await pg.end();
  console.log('Leftovers: demand_master rows for JAN/FEB/MAR 2031; QA members', qa.join(','), 'real member used', real.mbno);
  process.exit(s.finish() ? 1 : 0);
})();
