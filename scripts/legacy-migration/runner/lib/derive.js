'use strict';
// Pure derivation rules of migration-v1.md. No database access here: every function takes plain data and
// returns plain data, so each rule is unit-tested with small fixtures (tests/derive.test.js).
const dec = require('./dec');

const SHARE_HEAD = 'L1001', CD_HEAD = 'L1004', FRS1_HEAD = 'L1002', FRS2_HEAD = 'L1045', CASH_HEAD = 'A1001';
const BALANCE_HEADS = [SHARE_HEAD, CD_HEAD, FRS1_HEAD, FRS2_HEAD];

const isBlank = v => v === null || v === undefined || String(v).trim() === '';

// ---------------------------------------------------------------- member_master (section 11, 13)
/** full_name = f + m + l name, empty parts dropped, single spaces between parts (13.2). */
function fullName(f, m, l) {
  return [f, m, l].filter(p => !isBlank(p)).map(p => String(p).trim()).join(' ');
}

/**
 * cast_category from membercategory + castcategorymaster (13.2 step 3, Q25, Q79c).
 * catCodes: the CATEGORYCODE values of ALL membercategory rows of one member (may be empty or repeated).
 * castMap: Map(code -> name). Returns { value, reason } with reason null when resolved.
 */
function deriveCastCategory(catCodes, castMap) {
  const distinct = [...new Set((catCodes || []).filter(c => !isBlank(c)).map(c => String(Number(c))))];
  if (distinct.length === 0) return { value: null, reason: 'NO_CATEGORY' };
  if (distinct.length > 1) return { value: null, reason: 'CONFLICTING_CATEGORY', codes: distinct };
  const name = castMap.get(distinct[0]);
  if (isBlank(name)) return { value: null, reason: 'UNKNOWN_CATEGORY_CODE', codes: distinct };
  return { value: name, reason: null };
}

/** The target trigger trg_member_master_sync_retirement (11.4): date_of_retirement from dor if empty, then dor := date_of_retirement. */
function expectedRetirement(dor, dateOfRetirement) {
  const dr = isBlank(dateOfRetirement) ? (isBlank(dor) ? null : dor) : dateOfRetirement;
  return { dor: dr, date_of_retirement: dr };
}

/** The 18 members whose legacy dor differs from date_of_retirement (report line, Q16/Q79d). */
function dorDifferences(memberRows, canonTs) {
  const out = [];
  for (const r of memberRows) {
    if (isBlank(r.dor) || isBlank(r.date_of_retirement)) continue;
    if (canonTs(r.dor) !== canonTs(r.date_of_retirement)) out.push({ mbno: r.mbno, dor: r.dor, date_of_retirement: r.date_of_retirement });
  }
  return out;
}

function findDuplicates(values) {
  const seen = new Map();
  for (const v of values) { const k = String(v).trim(); seen.set(k, (seen.get(k) || 0) + 1); }
  return [...seen].filter(([, n]) => n > 1).map(([value, count]) => ({ value, count }));
}

// ---------------------------------------------------------------- headmaster (section 32)
/**
 * Q57: a blank PFLAG on an A-head becomes 'A' (the app treats blank as credit-normal, wrong for assets).
 * Blank on a credit-normal head (L, I, R, M) is left as it is: blank already means credit-normal, so it is correct
 * (legacy has L1046, L1047, L1048 like this; reported, not changed). Blank on an E-head (debit-normal, not
 * covered by Q57) is undecided: returns { undecided: true } and the run refuses.
 */
function fixHeadPflag(row) {
  if (!isBlank(row.pflag)) return { row, changed: false };
  const prefix = String(row.code || '').trim().charAt(0).toUpperCase();
  if (prefix === 'A') return { row: { ...row, pflag: 'A' }, changed: true };
  if (prefix === 'E') return { row, changed: false, undecided: true };
  return { row, changed: false, leftBlank: true };
}

// ---------------------------------------------------------------- office / wing masters (43.3, Q78)
function deriveOfficeMaster(divisionRows) {
  return divisionRows.map(r => ({
    officeno: r.officeno, office_name: r.name, division: r.divno === null || r.divno === undefined ? null : String(r.divno),
    address: r.address ?? null, city: r.city ?? null,
  }));
}
function deriveWingMaster(wingRows) {
  return wingRows.map(r => ({
    wingno: r.wingno === null || r.wingno === undefined ? r.wingno : String(r.wingno).trim(),
    wingname: r.wname ?? null,
    status_state: r.winstate === null || r.winstate === undefined ? '1' : String(r.winstate),
  }));
}

// ---------------------------------------------------------------- member_balances (section 19)
const NUM_MB_COLUMNS = ['shares', 'compulsory_deposit', 'rd_amt', 'regularloan', 'regularinstallamt', 'int_amount', 'emergency_loan_balance', 'einstallamt', 'eint_amount', 'frsbalance'];

/** Net credit movement of one head of one member: credits positive (liabilities / funds). All decimal strings. */
function netCredit(creditSum, debitSum) { return dec.parse(creditSum) - dec.parse(debitSum); }

/**
 * Shares, Compulsory_Deposit, FRSBalance of one member (19.4, 19.10), BY HEAD CODE.
 * opening: fundsmaster row (strings, may be null); nets: { L1001: units, L1004, L1002, L1045 } BigInt credit-minus-debit.
 */
function deriveMemberBalance(opening, nets) {
  const o = opening || {};
  const n = code => nets[code] || 0n;
  const shares = dec.parse(o.shareopbal) + n(SHARE_HEAD);
  const cd = dec.parse(o.cdopbal) + n(CD_HEAD);
  const frs = (dec.parse(o.mdopbal) + n(FRS1_HEAD)) + (dec.parse(o.md1_opbal) + n(FRS2_HEAD));
  return { shares, compulsory_deposit: cd, frsbalance: frs };
}

/**
 * One member_balances row per member_master member plus every legacy row with no member (19.4 "Rows").
 *  members: [{ mbno, pfno, officeno, name }]        (target member_master after step 5)
 *  legacyRows: Map(mbno -> legacy member_balances row, lower-case column names)
 *  fundsByMbno: Map(mbno -> fundsmaster strings)    netsByMbno: Map(mbno -> {code: units})
 * Columns not derived are copied from the legacy row; a member with no legacy row gets identity columns from
 * member_master and 0 in every amount column the app increments (a NULL would stay NULL after "col = col + x").
 */
function buildMemberBalanceRows({ members, legacyRows, fundsByMbno, netsByMbno }) {
  const rows = [], noLegacyRow = [], orphanRows = [];
  const memberSet = new Set();
  const make = (mbno, base, isLegacy) => {
    const derived = deriveMemberBalance(fundsByMbno.get(mbno), netsByMbno.get(mbno) || {});
    const row = { ...base, mbno };
    for (const c of NUM_MB_COLUMNS) if (!isLegacy && row[c] === undefined) row[c] = '0';
    row.shares = dec.format(derived.shares);
    row.compulsory_deposit = dec.format(derived.compulsory_deposit);
    row.frsbalance = dec.format(derived.frsbalance);
    return row;
  };
  for (const m of members) {
    const key = String(m.mbno);
    if (memberSet.has(key)) continue; // duplicate mbno is a pre-flight blocker; never emit two rows
    memberSet.add(key);
    const legacy = legacyRows.get(key);
    if (legacy) rows.push(make(key, legacy, true));
    else { noLegacyRow.push(key); rows.push(make(key, { pfno: /^\d+(\.\d+)?$/.test(String(m.pfno ?? '').trim()) ? String(m.pfno).trim() : null, member_name: m.name ?? null, officeno: m.officeno ?? null }, false)); }
  }
  for (const [key, legacy] of legacyRows) {
    if (memberSet.has(key)) continue;
    orphanRows.push(key);
    rows.push(make(key, legacy, true));
  }
  return { rows, noLegacyRow, orphanRows };
}

/**
 * 19.5(2): the gap between the derived member total and the GL head closing decomposes EXACTLY into
 *  - the opening gap of the population (members' openings vs the head's op_bal: known legacy data, 1.19 lakh for CD),
 *  - ledger movement of the head that belongs to no member_balances row (MBNO 0, members only in the ledger),
 * so residual must be 0 (it proves the loaded rows are the sum of opening + ledger of the population).
 * openingGapAll is the same opening gap over EVERY fundsmaster row: this is the figure compared with the tolerance.
 */
function reconcileToGl({ derivedTotal, headOpBal, headNet, populationOpeningTotal, populationNetTotal, allOpeningTotal }) {
  const headClosing = dec.parse(headOpBal) + headNet;
  const gap = dec.parse(derivedTotal) - headClosing;
  const openingGap = populationOpeningTotal - dec.parse(headOpBal);
  const uncoveredMovement = populationNetTotal - headNet;
  const openingGapAll = (allOpeningTotal === undefined ? populationOpeningTotal : allOpeningTotal) - dec.parse(headOpBal);
  return { headClosing, gap, openingGap, openingGapAll, uncoveredMovement, residual: gap - openingGap - uncoveredMovement };
}

// ---------------------------------------------------------------- share_monthly_balance (43.3, Q77)
const pad2 = n => String(n).padStart(2, '0');
function lastDayOfMonth(year, month) { return new Date(Date.UTC(year, month, 0)).getUTCDate(); }
/** [{year, month, date:'YYYY-MM-DD'}] month-ends from start (inclusive) to end (inclusive). */
function monthEnds(start, end) {
  const out = [];
  let y = start.year, m = start.month;
  while (y < end.year || (y === end.year && m <= end.month)) {
    out.push({ year: y, month: m, date: `${y}-${pad2(m)}-${pad2(lastDayOfMonth(y, m))}` });
    m++; if (m > 12) { m = 1; y++; }
  }
  return out;
}

/**
 * Month-end share balances: opening + cumulative net of L1001 up to each month-end.
 *  population: iterable of mbno strings; openings: Map(mbno -> shareopbal string)
 *  monthlyNets: [{ mbno, year, month, net: units }]  (net credit minus debit per calendar month, any month incl. before start)
 * A member is included only if it ever held shares (non-zero opening or any L1001 entry); from then on every month.
 */
function buildShareMonthlyRows({ population, openings, monthlyNets, start, end }) {
  const byMember = new Map();
  for (const r of monthlyNets) {
    const k = String(r.mbno);
    if (!byMember.has(k)) byMember.set(k, []);
    byMember.get(k).push(r);
  }
  const months = monthEnds(start, end);
  const rows = [];
  for (const mbno of population) {
    const k = String(mbno);
    const open = dec.parse(openings.get(k));
    const entries = byMember.get(k) || [];
    if (open === 0n && entries.length === 0) continue;
    const perMonth = new Map(entries.map(e => [e.year * 100 + e.month, e.net]));
    // movement strictly before the first snapshot month
    let running = open;
    for (const e of entries) if (e.year * 100 + e.month < start.year * 100 + start.month) running += e.net;
    for (const me of months) {
      running += perMonth.get(me.year * 100 + me.month) || 0n;
      rows.push({ mbno: k, snapshot_month: me.month, snapshot_year: me.year, share_balance: dec.format(running), snapshot_date: me.date });
    }
  }
  return rows;
}

// ---------------------------------------------------------------- tblcashbook (section 39.7, Q70)
/**
 * Old Cash Book rule (proven on three printouts): every ledger line of the date except A1001; CR = receipt,
 * DR = payment; MODEOFPAY 'C' = cash, anything else (B, J, empty) = transfer; one row per date and head.
 * aggregates: [{ date:'YYYY-MM-DD', code, tt:'CR'|'DR', mode, amt }] already summed per (date, code, tt, mode>C?)
 */
function buildCashbookRows(aggregates, headNames) {
  const map = new Map();
  for (const a of aggregates) {
    if (String(a.code).trim() === CASH_HEAD) continue;
    const key = `${a.date}|${a.code}`;
    let r = map.get(key);
    if (!r) { r = { trans_date: a.date, headcode: a.code, headname: headNames.get(a.code) ?? null, rcash: 0n, rtransfer: 0n, pcash: 0n, ptransfer: 0n }; map.set(key, r); }
    const cash = String(a.mode || '').trim().toUpperCase() === 'C';
    const credit = String(a.tt).trim().toUpperCase() === 'CR';
    const amt = dec.parse(a.amt);
    if (credit) { if (cash) r.rcash += amt; else r.rtransfer += amt; }
    else if (cash) r.pcash += amt; else r.ptransfer += amt;
  }
  return [...map.values()].sort((x, y) => (x.trans_date < y.trans_date ? -1 : x.trans_date > y.trans_date ? 1 : x.headcode < y.headcode ? -1 : x.headcode > y.headcode ? 1 : 0))
    .map(r => ({ ...r, rcash: dec.format(r.rcash), rtransfer: dec.format(r.rtransfer), pcash: dec.format(r.pcash), ptransfer: dec.format(r.ptransfer) }));
}

/** A1001 balance through the last loaded day: assets are debit-normal. */
function cashInHand(opBal, debitSum, creditSum) { return dec.parse(opBal) + dec.parse(debitSum) - dec.parse(creditSum); }

/**
 * Opening row dated 31-Oct-2019, sized so that the sum of ALL rows gives cash = cash in hand and transfer = 0
 * (the first live day then opens at the ledger's cash in hand). Net cash/transfer = receipts - payments.
 */
function buildOpeningCashbookRow(rows, cashInHandUnits, { date = '2019-10-31', headcode = CASH_HEAD, headname = 'OPENING BALANCE 31-10-2019' } = {}) {
  let cash = 0n, transfer = 0n;
  for (const r of rows) {
    cash += dec.parse(r.rcash) - dec.parse(r.pcash);
    transfer += dec.parse(r.rtransfer) - dec.parse(r.ptransfer);
  }
  const needCash = cashInHandUnits - cash, needTransfer = 0n - transfer;
  return {
    trans_date: date, headcode, headname,
    rcash: dec.format(needCash > 0n ? needCash : 0n), pcash: dec.format(needCash < 0n ? -needCash : 0n),
    rtransfer: dec.format(needTransfer > 0n ? needTransfer : 0n), ptransfer: dec.format(needTransfer < 0n ? -needTransfer : 0n),
  };
}

function cashbookTotals(rows) {
  const t = { rcash: 0n, rtransfer: 0n, pcash: 0n, ptransfer: 0n };
  for (const r of rows) for (const k of Object.keys(t)) t[k] += dec.parse(r[k]);
  return Object.fromEntries(Object.entries(t).map(([k, v]) => [k, dec.format(v)]));
}

// ---------------------------------------------------------------- counters (44.2 step 13, Q63, B20)
/** 'P27334' -> { letter:'P', number:27334, width:5 } */
function parseVoucherNo(v) {
  const m = /^([A-Za-z]+)(\d+)$/.exec(String(v || '').trim());
  return m ? { letter: m[1].toUpperCase(), number: Number(m[2]), width: m[2].length } : null;
}
/** Highest number per letter among ledger voucher numbers (letters P R J D only matter for voucher_master). */
function maxVoucherByLetter(voucherNos) {
  const out = {};
  for (const v of voucherNos) { const p = parseVoucherNo(v); if (p && (out[p.letter] === undefined || p.number > out[p.letter])) out[p.letter] = p.number; }
  return out;
}
/** Q63: never lower a counter; raise to the highest ledger number of its letter. */
function raiseVoucherCounter(current, maxByLetter, letter) {
  const p = parseVoucherNo(current);
  const need = maxByLetter[letter];
  if (!p) return { value: need === undefined ? current : `${letter}${String(need).padStart(5, '0')}`, raised: need !== undefined };
  if (need !== undefined && need > p.number) return { value: `${letter}${String(need).padStart(p.width, '0')}`, raised: true };
  return { value: current, raised: false };
}
/** sequence_master: last_value never lowered; the next handed-out number must be above `required`. */
function raiseSequence(lastValue, required) {
  const cur = Number(lastValue || 0);
  return required > cur ? { value: required, raised: true } : { value: cur, raised: false };
}

// ---------------------------------------------------------------- busrules (42.2, Q75)
const SOCIETY_BUSRULES_COLUMNS = ['elnpenalrate', 'alnpenalrate', 'rlngracedays', 'elngracedays', 'alngracedays', 'rlnsmpct', 'elnsmpct', 'alnsmpct', 'rlnsmdiv', 'elnsmdiv', 'alnsmdiv'];

/** The society's 11 values must all be present, numeric and non-negative. Returns the list of problems (empty = ok). */
function validateSocietyBusrules(values) {
  const problems = [];
  if (!values || typeof values !== 'object') return ['society values file is missing or not an object'];
  for (const k of SOCIETY_BUSRULES_COLUMNS) {
    const v = values[k];
    if (v === undefined || v === null || String(v).trim() === '') { problems.push(`${k}: no value`); continue; }
    if (!/^\d+(\.\d+)?$/.test(String(v).trim())) problems.push(`${k}: not a non-negative number (${JSON.stringify(v)})`);
  }
  for (const k of ['rlnsmdiv', 'elnsmdiv', 'alnsmdiv']) if (/^\d+(\.\d+)?$/.test(String(values[k] ?? '').trim()) && Number(values[k]) === 0) problems.push(`${k}: a divisor cannot be 0`);
  for (const k of Object.keys(values)) if (!SOCIETY_BUSRULES_COLUMNS.includes(k) && !k.startsWith('_')) problems.push(`${k}: unknown column`);
  return problems;
}

/**
 * Go-live row: copy of the latest legacy row (greatest APPDATE, then greatest SRNO) with APPDATE = go-live date,
 * SRNO = max SRNO + 1 and the society's 11 values. Throws if the values are not valid.
 */
function buildBusrulesGoLiveRow(legacyRows, societyValues, goLiveDate) {
  const problems = validateSocietyBusrules(societyValues);
  if (problems.length) throw new Error('busrules go-live row: ' + problems.join('; '));
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(goLiveDate || ''))) throw new Error('busrules go-live row: --go-live-date YYYY-MM-DD is required');
  if (!legacyRows.length) throw new Error('busrules go-live row: legacy busrules is empty');
  const ts = r => String(r.appdate).slice(0, 10);
  const latest = legacyRows.reduce((best, r) => {
    if (!best) return r;
    if (ts(r) > ts(best)) return r;
    if (ts(r) === ts(best) && dec.parse(r.srno) > dec.parse(best.srno)) return r;
    return best;
  }, null);
  const maxSrno = legacyRows.reduce((m, r) => (dec.parse(r.srno) > m ? dec.parse(r.srno) : m), 0n);
  const row = { ...latest };
  row.srno = dec.format(maxSrno + dec.ONE);
  row.appdate = `${goLiveDate}T00:00:00`;
  for (const k of SOCIETY_BUSRULES_COLUMNS) row[k] = String(societyValues[k]).trim();
  return { row, source: latest, tiedOnLatestDate: legacyRows.filter(r => ts(r) === ts(latest)).length > 1 };
}

module.exports = {
  SHARE_HEAD, CD_HEAD, FRS1_HEAD, FRS2_HEAD, CASH_HEAD, BALANCE_HEADS, NUM_MB_COLUMNS, SOCIETY_BUSRULES_COLUMNS,
  isBlank, fullName, deriveCastCategory, expectedRetirement, dorDifferences, findDuplicates, fixHeadPflag,
  deriveOfficeMaster, deriveWingMaster, netCredit, deriveMemberBalance, buildMemberBalanceRows, reconcileToGl,
  monthEnds, buildShareMonthlyRows, buildCashbookRows, cashInHand, buildOpeningCashbookRow, cashbookTotals,
  parseVoucherNo, maxVoucherByLetter, raiseVoucherCounter, raiseSequence, validateSocietyBusrules, buildBusrulesGoLiveRow,
};
