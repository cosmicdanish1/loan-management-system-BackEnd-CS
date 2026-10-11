'use strict';
/**
 * Classifies every ACTIVE loan account of the legacy MSSQL (ledger closing balance > Rs 100) BEFORE migration, from a read-only dry-run of the
 * replay (reports/dryrun-active-all.log). Member level, because the replay works per member.
 *   CLEAN       - nothing the migration cannot explain: schedule built from the member's payments, no data exception, no credit balance
 *   TO CONFIRM  - the migration works, but a figure came from a rule (schedule from the legacy loan terms, ledger-based reopening,
 *                 duplicate legacy row chosen without payments to prove it)
 *   MANUAL      - data exception or a decision needed (see reasons)
 * Output: reports/active-classification.json
 */
const fs = require('node:fs');
const path = require('node:path');
const R = path.join(__dirname, 'reports');
const rows = fs.readFileSync(path.join(R, 'active-loans-mssql.psv'), 'utf8').split(/\r?\n/).filter(Boolean).map(l => l.split('|'));
const credit = new Set(fs.readFileSync(path.join(R, 'credit-heads-mssql.psv'), 'utf8').split(/\r?\n/).filter(Boolean).map(l => l.split('|')[0]));
const CORR = JSON.parse(fs.readFileSync(path.join(__dirname, 'manual-corrections.json'), 'utf8'));
const corrMembers = new Set(CORR.map(c => String(c.mbno)));
const log = fs.readFileSync(path.join(R, process.argv[2] || 'dryrun-active-all.log'), 'utf8');

const blocks = new Map();
{
  const parts = log.split(/^===== (\d+) =====$/m);
  for (let i = 1; i < parts.length; i += 2) {
    const body = parts[i + 1].split('===== SUMMARY =====')[0];
    blocks.set(parts[i], body);
  }
}
const members = [...new Set(rows.map(r => r[0]))];
const out = [];
const memberVerdict = new Map();
for (const mb of members) {
  const reasons = { manual: [], confirm: [] };
  const body = blocks.get(mb);
  if (body === undefined) {
    const allEmpty = rows.filter(r => r[0] === mb).every(r => Number(r[6]) === 0);
    reasons.manual.push(allEmpty ? 'No ledger entries at all (opening balance only, never paid in the ledger window): EMI and schedule unknown' : 'Not processed by the replay (outside the replay scope)');
  }
  else {
    if (/ERROR for/.test(body)) reasons.manual.push('Replay error');
    const flags = body.split(/\r?\n/).filter(l => l.startsWith('  FLAG: ')).map(l => l.slice(8));
    const expect = [...body.matchAll(/EXPECT case=(\d+) final balance ~₹(-?[\d.]+)/g)].map(m => ({ c: m[1], bal: Number(m[2]) }));
    const sched = new Set([...body.matchAll(/EFFECTIVE_SCHEDULE case=(\d+)/g)].map(m => m[1]));
    const openCases = expect.filter(e => e.bal > 0.5).map(e => e.c);
    const activeHeads = rows.filter(r => r[0] === mb).length;
    if (openCases.length < activeHeads) reasons.manual.push(`Ledger shows ${activeHeads} active loan account(s) but the replay finds ${openCases.length} open loan(s)`);
    const noSched = openCases.filter(c => !sched.has(c));
    if (noSched.length) reasons.manual.push(`Open loan(s) without any schedule: ${noSched.join(', ')}`);
    for (const f of flags) {
      const m = f.match(/case[= ](\d+)/);
      const isOpen = m ? openCases.includes(m[1]) : true;
      if (f.includes('SCHEDULE_VERSION_NOT_BUILT')) { if (isOpen) reasons.manual.push('Schedule could not be built for an open loan (case ' + (m ? m[1] : '?') + ')'); }
      else if (f.includes('schedule from legacy loan terms')) { if (isOpen) reasons.confirm.push('Schedule built from the legacy loan terms (case ' + (m ? m[1] : '?') + ')'); }
      else if (f.includes('LEDGER_OWES') || f.includes('LEDGER_BELOW')) reasons.manual.push('Ledger owes but no legacy loan row explains it');
      else if (f.includes('no case found to receive') || f.startsWith('Unattributed CR') || f.startsWith('Consolidation-close')) reasons.manual.push('Debit/credit with no loan to apply to');
      else if (f.startsWith('MANUAL_CORRECTION')) reasons.manual.push('Manual correction applied');
      else if (f.startsWith('Mixed RLN/ALN')) reasons.manual.push('Mixed regular/emergency voucher not split');
      else if (f.includes('has no loan case to be recorded on')) reasons.manual.push('Interest credit with no loan case');
      else if (f.includes('ledger-based')) reasons.confirm.push('Loan reopened / debit applied by the ledger');
      else if (f.includes('duplicate legacy loan row ignored')) { if (/\(0 payments/.test(f)) reasons.confirm.push('Duplicate legacy loan row chosen without payments to prove which is real'); }
    }
  }
  if (credit.has(mb)) reasons.manual.push('A loan account of this member is in credit (overpaid / wrong loan type)');
  if (corrMembers.has(mb)) reasons.manual.push('Known ledger fault (manual correction register)');
  const verdict = reasons.manual.length ? 'MANUAL' : reasons.confirm.length ? 'TO CONFIRM' : 'CLEAN';
  memberVerdict.set(mb, { verdict, manual: [...new Set(reasons.manual)], confirm: [...new Set(reasons.confirm)] });
}
for (const r of rows) {
  const v = memberVerdict.get(r[0]);
  out.push({ member: r[0], name: r[1], head: r[2], opening: Number(r[3]), net: Number(r[4]), closing: Number(r[5]), ledgerRows: Number(r[6]), lastEntry: r[7] === 'NULL' ? '' : r[7], latestCase: r[8],
             verdict: v.verdict, reasons: [...v.manual, ...v.confirm] });
}
fs.writeFileSync(path.join(R, 'active-classification.json'), JSON.stringify(out, null, 1));
const cnt = k => out.filter(o => o.verdict === k).length;
const mcnt = k => [...memberVerdict.values()].filter(v => v.verdict === k).length;
console.log(`active loan accounts ${out.length}: CLEAN ${cnt('CLEAN')}, TO CONFIRM ${cnt('TO CONFIRM')}, MANUAL ${cnt('MANUAL')}`);
console.log(`members ${memberVerdict.size}: CLEAN ${mcnt('CLEAN')}, TO CONFIRM ${mcnt('TO CONFIRM')}, MANUAL ${mcnt('MANUAL')}`);
fs.writeFileSync(path.join(R, 'active-members-clean.txt'), [...memberVerdict].filter(([, v]) => v.verdict === 'CLEAN').map(([m]) => m).join('\n') + '\n');
const rc = {};
for (const v of memberVerdict.values()) for (const x of [...v.manual, ...v.confirm]) { const k = x.replace(/\d+(, \d+)*/g, '#').slice(0, 90); rc[k] = (rc[k] || 0) + 1; }
console.log(Object.entries(rc).sort((a, b) => b[1] - a[1]).map(([k, n]) => `  ${n}  ${k}`).join('\n'));
