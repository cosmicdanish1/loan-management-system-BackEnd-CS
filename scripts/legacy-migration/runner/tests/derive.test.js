'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const dec = require('../lib/dec');
const d = require('../lib/derive');
const { canonTimestamp } = require('../lib/canon');

test('dec: exact parse/format, exponent forms, no float drift', () => {
  assert.equal(dec.normalize('1234.5600'), '1234.56');
  assert.equal(dec.normalize(0.1), '0.1');
  assert.equal(dec.normalize('1e-7'), '0.0000001');
  assert.equal(dec.normalize('-0.000'), '0');
  assert.equal(dec.normalize('+5'), '5');
  assert.equal(dec.format(dec.add('0.1', '0.2')), '0.3');
  assert.equal(dec.format(dec.sum(['4167', '4167', '4167', '4167', '4167'])), '20835');
  assert.throws(() => dec.parse('0.12345678901'));
  assert.ok(dec.within('100.4', '100', '0.5'));
  assert.ok(!dec.within('101', '100', '0.5'));
});

test('fullName drops empty parts and trims', () => {
  assert.equal(d.fullName('A', null, 'C'), 'A C');
  assert.equal(d.fullName(' A ', '', ' C'), 'A C');
  assert.equal(d.fullName('A', 'B', 'C'), 'A B C');
  assert.equal(d.fullName(null, null, null), '');
});

test('cast_category: one code, repeated code, none, conflict, unknown (13.2)', () => {
  const cast = new Map([['1', 'OBC'], ['2', 'OPEN'], ['3', 'SC'], ['4', 'ST']]);
  assert.deepEqual(d.deriveCastCategory([2], cast), { value: 'OPEN', reason: null });
  assert.deepEqual(d.deriveCastCategory([2, 2, 2], cast), { value: 'OPEN', reason: null });
  assert.equal(d.deriveCastCategory([], cast).reason, 'NO_CATEGORY');
  assert.equal(d.deriveCastCategory([1, 2], cast).reason, 'CONFLICTING_CATEGORY');
  assert.equal(d.deriveCastCategory([9], cast).reason, 'UNKNOWN_CATEGORY_CODE');
  assert.equal(d.deriveCastCategory([1, 2], cast).value, null);
});

test('retirement trigger emulation and the 18-member report rule (11.4)', () => {
  assert.deepEqual(d.expectedRetirement(null, '2030-01-01T00:00:00'), { dor: '2030-01-01T00:00:00', date_of_retirement: '2030-01-01T00:00:00' });
  assert.deepEqual(d.expectedRetirement('2029-01-01T00:00:00', null), { dor: '2029-01-01T00:00:00', date_of_retirement: '2029-01-01T00:00:00' });
  assert.deepEqual(d.expectedRetirement('2029-01-01T00:00:00', '2030-01-01T00:00:00').dor, '2030-01-01T00:00:00');
  assert.deepEqual(d.expectedRetirement(null, null), { dor: null, date_of_retirement: null });
  const rows = [
    { mbno: '1', dor: '2029-01-01T00:00:00', date_of_retirement: '2030-01-01T00:00:00' },
    { mbno: '2', dor: '2030-01-01T00:00:00.000', date_of_retirement: '2030-01-01T00:00:00' },
    { mbno: '3', dor: null, date_of_retirement: '2030-01-01T00:00:00' },
  ];
  assert.deepEqual(d.dorDifferences(rows, canonTimestamp).map(r => r.mbno), ['1']);
});

test('duplicate member numbers are found (blocker 44.1)', () => {
  assert.deepEqual(d.findDuplicates(['990042294', '990042294', '5', '990042301', '990042301', '990042301']).map(x => [x.value, x.count]), [['990042294', 2], ['990042301', 3]]);
  assert.deepEqual(d.findDuplicates(['1', '2']), []);
});

test('headmaster PFLAG: blank on an A head becomes A, blank on L/I/R is left, blank on E is undecided (Q57)', () => {
  assert.deepEqual(d.fixHeadPflag({ code: 'A1048', pflag: ' ' }), { row: { code: 'A1048', pflag: 'A' }, changed: true });
  assert.equal(d.fixHeadPflag({ code: 'L1001', pflag: 'L' }).changed, false);
  assert.equal(d.fixHeadPflag({ code: 'L1046', pflag: '' }).leftBlank, true);
  assert.equal(d.fixHeadPflag({ code: 'L1046', pflag: '' }).row.pflag, '');
  assert.equal(d.fixHeadPflag({ code: 'E1099', pflag: '' }).undecided, true);
  assert.equal(d.fixHeadPflag({ code: 'A1050', pflag: null }).row.pflag, 'A');
});

test('office/wing masters derive from division_master / wingmast (Q78)', () => {
  assert.deepEqual(d.deriveOfficeMaster([{ officeno: 1, divno: 5, name: 'X', address: 'Y', city: null }]), [{ officeno: 1, office_name: 'X', division: '5', address: 'Y', city: null }]);
  assert.deepEqual(d.deriveWingMaster([{ wingno: 'BHILAI ', wname: 'BHILAI', winstate: 1 }]), [{ wingno: 'BHILAI', wingname: 'BHILAI', status_state: '1' }]);
});

test('member balance by head code: opening + credit - debit (19.4, 19.9)', () => {
  // member 990042276 CD: 1,395 + 20,800 - 3,693 = 18,502
  const nets = { L1004: dec.parse('20800') - dec.parse('3693'), L1001: 0n };
  const r = d.deriveMemberBalance({ cdopbal: '1395', shareopbal: '0' }, nets);
  assert.equal(dec.format(r.compulsory_deposit), '18502');
  // 990042274: 11,430 - 11,430 = 0
  assert.equal(dec.format(d.deriveMemberBalance({ cdopbal: '11430' }, { L1004: dec.parse('-11430') }).compulsory_deposit), '0');
  // FRS = (mdopbal + L1002) + (md1_opbal + L1045)
  const f = d.deriveMemberBalance({ mdopbal: '100', md1_opbal: '5200' }, { L1002: dec.parse('16'), L1045: dec.parse('-17') });
  assert.equal(dec.format(f.frsbalance), '5299');
  assert.equal(dec.format(d.deriveMemberBalance(null, {}).shares), '0');
});

test('member_balances rows: members + orphan legacy rows, no-legacy-row members get zeros (19.4)', () => {
  const members = [{ mbno: '1', pfno: 'P1', officeno: 3, name: 'A B' }, { mbno: '2', pfno: 'P2', officeno: 1, name: 'C D' }, { mbno: '2', pfno: 'dup', officeno: 1, name: 'dup' }];
  const legacyRows = new Map([
    ['1', { srno: 7, mbno: '1', shares: '999', compulsory_deposit: '999', rd_amt: '281', regularloan: '5', dep_date: '2019-11-29T00:00:00' }],
    ['77', { srno: 9, mbno: '77', shares: '1', compulsory_deposit: '1', rd_amt: '3' }],
  ]);
  const fundsByMbno = new Map([['1', { shareopbal: '100', cdopbal: '200' }], ['77', { shareopbal: '10' }]]);
  const netsByMbno = new Map([['1', { L1001: dec.parse('50'), L1004: dec.parse('-200') }], ['2', { L1001: dec.parse('7') }]]);
  const out = d.buildMemberBalanceRows({ members: [...members, { mbno: '3', pfno: 'AB-12', officeno: 2, name: 'E F' }], legacyRows, fundsByMbno, netsByMbno });
  assert.equal(out.rows.length, 4);
  assert.equal(out.rows.find(r => r.mbno === '3').pfno, null); // non-numeric PF number cannot go into the float column
  assert.equal(out.rows.find(r => r.mbno === '2').pfno, null); // 'P2' is not numeric either
  const m1 = out.rows.find(r => r.mbno === '1');
  assert.equal(m1.shares, '150'); assert.equal(m1.compulsory_deposit, '0'); assert.equal(m1.rd_amt, '281'); assert.equal(m1.regularloan, '5');
  assert.equal(m1.dep_date, '2019-11-29T00:00:00');
  const m2 = out.rows.find(r => r.mbno === '2');
  assert.equal(m2.shares, '7'); assert.equal(m2.rd_amt, '0'); assert.equal(m2.regularloan, '0'); assert.equal(m2.member_name, 'C D'); assert.equal(m2.srno, undefined);
  const o = out.rows.find(r => r.mbno === '77');
  assert.equal(o.shares, '10');
  assert.deepEqual(out.noLegacyRow, ['2', '3']); assert.deepEqual(out.orphanRows, ['77']);
});

test('GL reconciliation decomposes exactly (19.5)', () => {
  const r = d.reconcileToGl({ derivedTotal: '1000', headOpBal: '900', headNet: dec.parse('150'), populationOpeningTotal: dec.parse('950'), populationNetTotal: dec.parse('140') });
  // headClosing 1050; gap -50; openingGap +50; uncovered -10 -> residual -90? check formula explicitly
  assert.equal(r.headClosing, dec.parse('1050'));
  assert.equal(r.gap, dec.parse('-50'));
  assert.equal(r.openingGap, dec.parse('50'));
  assert.equal(r.uncoveredMovement, dec.parse('-10'));
  // a consistent case has residual 0
  const ok = d.reconcileToGl({ derivedTotal: '1090', headOpBal: '900', headNet: dec.parse('150'), populationOpeningTotal: dec.parse('950'), populationNetTotal: dec.parse('140') });
  assert.equal(ok.residual, 0n);
  // opening gap over ALL fundsmaster rows is what the tolerance applies to (CD dump: 360,119,176 head vs 359,999,928 members = 119,248)
  const all = d.reconcileToGl({ derivedTotal: '1090', headOpBal: '900', headNet: dec.parse('150'), populationOpeningTotal: dec.parse('950'), populationNetTotal: dec.parse('140'), allOpeningTotal: dec.parse('955') });
  assert.equal(all.openingGapAll, dec.parse('55')); assert.equal(all.residual, 0n);
});

test('month ends from Nov 2019 through the last loaded month', () => {
  const m = d.monthEnds({ year: 2019, month: 11 }, { year: 2020, month: 3 });
  assert.deepEqual(m.map(x => x.date), ['2019-11-30', '2019-12-31', '2020-01-31', '2020-02-29', '2020-03-31']);
  assert.equal(d.monthEnds({ year: 2019, month: 11 }, { year: 2026, month: 11 }).length, 85);
});

test('share_monthly_balance: opening + cumulative L1001, entries before the start count (Q77)', () => {
  const rows = d.buildShareMonthlyRows({
    population: ['1', '2', '3'],
    openings: new Map([['1', '100'], ['2', '0']]),
    monthlyNets: [
      { mbno: '1', year: 2019, month: 12, net: dec.parse('50') },
      { mbno: '1', year: 2020, month: 2, net: dec.parse('-30') },
      { mbno: '2', year: 2019, month: 3, net: dec.parse('40') }, // before start: part of the opening position
    ],
    start: { year: 2019, month: 11 }, end: { year: 2020, month: 2 },
  });
  const of = (m, y, mo) => rows.find(r => r.mbno === m && r.snapshot_year === y && r.snapshot_month === mo).share_balance;
  assert.equal(of('1', 2019, 11), '100'); assert.equal(of('1', 2019, 12), '150'); assert.equal(of('1', 2020, 1), '150'); assert.equal(of('1', 2020, 2), '120');
  assert.equal(of('2', 2019, 11), '40'); assert.equal(of('2', 2020, 2), '40');
  assert.equal(rows.filter(r => r.mbno === '3').length, 0); // never held shares
  assert.equal(rows.find(r => r.mbno === '1' && r.snapshot_month === 2).snapshot_date, '2020-02-29');
});

test('cash book rule: every line except A1001, CR=receipt DR=payment, C=cash else transfer (39.7)', () => {
  const agg = [
    { date: '2019-11-01', code: 'I1002', tt: 'CR', mode: 'C', amt: '26422' },
    { date: '2019-11-01', code: 'I1002', tt: 'CR', mode: 'B', amt: '68990' },
    { date: '2019-11-01', code: 'I1002', tt: 'CR', mode: 'B', amt: '79201' },
    { date: '2019-11-01', code: 'I1002', tt: 'CR', mode: 'J', amt: '30000' },
    { date: '2019-11-01', code: 'A1001', tt: 'DR', mode: 'C', amt: '999' },
    { date: '2019-11-01', code: 'E1026', tt: 'DR', mode: 'C', amt: '60530' },
    { date: '2019-11-02', code: 'E1026', tt: 'DR', mode: null, amt: '5' },
  ];
  const rows = d.buildCashbookRows(agg, new Map([['I1002', 'INTT FROM MEMBER']]));
  assert.equal(rows.length, 3);
  const i = rows.find(r => r.headcode === 'I1002');
  assert.equal(i.rcash, '26422'); assert.equal(i.rtransfer, '178191'); assert.equal(i.pcash, '0'); assert.equal(i.headname, 'INTT FROM MEMBER');
  assert.equal(rows.find(r => r.trans_date === '2019-11-02').ptransfer, '5');
  assert.equal(rows.some(r => r.headcode === 'A1001'), false);
});

test('opening cash book row makes the first live day open at the ledger cash in hand (Q70)', () => {
  const rows = [
    { rcash: '100', rtransfer: '10', pcash: '30', ptransfer: '60' },
    { rcash: '0', rtransfer: '5', pcash: '0', ptransfer: '0' },
  ]; // net cash +70, net transfer -45
  const open = d.buildOpeningCashbookRow(rows, dec.parse('-6560000'));
  assert.equal(open.trans_date, '2019-10-31');
  assert.equal(open.pcash, '6560070'); assert.equal(open.rcash, '0');
  assert.equal(open.rtransfer, '45'); assert.equal(open.ptransfer, '0');
  const all = d.cashbookTotals([open, ...rows]);
  assert.equal(dec.format(dec.parse(all.rcash) - dec.parse(all.pcash)), '-6560000');
  assert.equal(dec.format(dec.parse(all.rtransfer) - dec.parse(all.ptransfer)), '0');
  assert.equal(d.cashInHand('178940', '1815568170', '1882978170'), dec.parse('178940') + dec.parse('1815568170') - dec.parse('1882978170'));
});

test('voucher counters never go below the ledger, never get lowered (Q63)', () => {
  const max = d.maxVoucherByLetter(['P27332', 'P27100', 'R58811', 'J34394', 'D00800', 'VCH101', 'G08001', 'bad', null]);
  assert.equal(max.P, 27332); assert.equal(max.R, 58811); assert.equal(max.D, 800);
  assert.deepEqual(d.raiseVoucherCounter('P27334', max, 'P'), { value: 'P27334', raised: false });
  assert.deepEqual(d.raiseVoucherCounter('P27300', max, 'P'), { value: 'P27332', raised: true });
  assert.deepEqual(d.raiseVoucherCounter('D00801', max, 'D'), { value: 'D00801', raised: false });
  assert.deepEqual(d.raiseSequence(889288, 21233), { value: 889288, raised: false });
  assert.deepEqual(d.raiseSequence(0, 21233), { value: 21233, raised: true });
});

test('busrules: society values must be complete (blocker) and the go-live row is built from the latest row (Q75)', () => {
  const values = { elnpenalrate: '3', alnpenalrate: '3', rlngracedays: '0', elngracedays: '0', alngracedays: '0', rlnsmpct: '1', elnsmpct: '1', alnsmpct: '1', rlnsmdiv: '4', elnsmdiv: '4', alnsmdiv: '4' };
  assert.deepEqual(d.validateSocietyBusrules(values), []);
  assert.ok(d.validateSocietyBusrules({ ...values, rlnsmdiv: '' }).length >= 1);
  assert.ok(d.validateSocietyBusrules({ ...values, rlnsmdiv: 'abc' })[0].includes('rlnsmdiv'));
  assert.ok(d.validateSocietyBusrules({ ...values, alnsmdiv: '0' }).some(p => p.includes('divisor')));
  assert.ok(d.validateSocietyBusrules({}).length === 11);
  assert.ok(d.validateSocietyBusrules(null).length === 1);
  const legacy = [
    { srno: '4030', appdate: '2025-11-01T00:00:00', alnmaxnoinst: '60' },
    { srno: '4031', appdate: '2025-11-19T00:00:00', alnmaxnoinst: '80' },
    { srno: '4032', appdate: '2025-11-19T00:00:00', alnmaxnoinst: '100' },
  ];
  const { row, tiedOnLatestDate } = d.buildBusrulesGoLiveRow(legacy, values, '2026-11-04');
  assert.equal(row.srno, '4033'); assert.equal(row.alnmaxnoinst, '100'); assert.equal(row.appdate, '2026-11-04T00:00:00'); assert.equal(row.rlnsmdiv, '4');
  assert.equal(tiedOnLatestDate, true);
  assert.throws(() => d.buildBusrulesGoLiveRow(legacy, { ...values, elnsmpct: null }, '2026-11-04'), /elnsmpct/);
  assert.throws(() => d.buildBusrulesGoLiveRow(legacy, values, ''), /go-live-date/);
});

test('member_balances: a numeric PF number of a member without a legacy row is kept, text is dropped', () => {
  const out = require('../lib/derive').buildMemberBalanceRows({
    members: [{ mbno: '10', pfno: '12345', officeno: 1, name: 'A' }, { mbno: '11', pfno: 'X-9', officeno: 1, name: 'B' }],
    legacyRows: new Map(), fundsByMbno: new Map(), netsByMbno: new Map(),
  });
  assert.equal(out.rows.find(r => r.mbno === '10').pfno, '12345');
  assert.equal(out.rows.find(r => r.mbno === '11').pfno, null);
});
