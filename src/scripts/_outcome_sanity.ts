import 'dotenv/config';
/**
 * OUTCOME SANITY TEST for migrated loans (read-only). A loan can pass every data check and still produce a result nobody should accept
 * without a look (610028678: principal Rs 52,336, early-closure amount Rs 1,34,129). For every open loan of the members in MBNO_FILE this
 * runs the real early-closure calculation and marks the loan REVIEW when any rule fires:
 *   - closure amount > RATIO x outstanding principal               (default 1.5)
 *   - instalments behind (principal still due on a due month) >= BEHIND   (default 6)
 *   - no payment for >= SILENT months                               (default 12)
 *   - penalty > principal still unpaid                              (a penalty bigger than the debt it is charged on)
 * Usage: MBNO_FILE=reports/active-members-clean.txt npx ts-node --transpile-only -r tsconfig-paths/register src/scripts/_outcome_sanity.ts <label>
 * Output: scripts/legacy-migration/reports/outcome-sanity-<label>.json
 */
import { readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { DataSource } from 'typeorm';
import { LoanRepaymentService } from '../modules/loan/services-v2/loan-repayment.service';
import { LoanEligibilityService } from '../modules/loan/services-v2/loan-eligibility.service';
import { RdRulesService } from '../modules/rd/rd-rules.service';
import { RdBalanceEventsService } from '../modules/rd/services/rd-balance-events.service';

const RATIO = Number(process.env.SANITY_RATIO || 1.5);
const BEHIND = Number(process.env.SANITY_BEHIND || 6);
const SILENT = Number(process.env.SANITY_SILENT_MONTHS || 12);
const ds = new DataSource({ type: 'postgres', host: 'localhost', port: 5432, database: 'EMP_Espat_Society', username: 'postgres', password: process.env.DB_PASSWORD,
    entities: [__dirname + '/../**/*.entity{.ts,.js}'], synchronize: false, logging: false });
const r2 = (n: number) => Math.round(n * 100) / 100;

(async () => {
    const file = process.env.MBNO_FILE;
    if (!file) throw new Error('Set MBNO_FILE');
    const label = process.argv[2] || 'final';
    const members = readFileSync(file, 'utf8').split(/\r?\n/).map(s => s.trim()).filter(Boolean);
    await ds.initialize();
    const rd = new RdRulesService(ds); const ev = new RdBalanceEventsService(ds, rd);
    const svc = new LoanRepaymentService(ds, new LoanEligibilityService(ds, ev, rd), ev);
    const today = new Date();
    const out: any[] = [];
    for (let i = 0; i < members.length; i++) {
        const mb = members[i];
        const loans = await ds.query(`SELECT loancaseno::text AS c, loantype AS t, balance::numeric AS bal FROM loan_master WHERE mbno = $1::numeric AND balance > 0`, [mb]);
        for (const l of loans) {
            const row: any = { member: mb, loanType: l.t === 'RLN' ? 'RLN' : 'ALN', loanCase: l.c, recordBalance: r2(Number(l.bal)) };
            try {
                const q: any = await svc.calculateEarlyClosure(l.c, today, 0, false, mb);
                const unpaid: any[] = Array.isArray(q.unpaidInstallments) ? q.unpaidInstallments : [];
                const behind = unpaid.filter(u => (u.principalDue || 0) > 0.5).length;
                const last = (await ds.query(`SELECT max(payment_date) AS d FROM loan_repayment_ledger WHERE mbno = $1::numeric AND loancaseno::text = $2 AND loantype = $3
                                               AND COALESCE(is_payroll_lag_credit, false) = false AND COALESCE(narration, '') NOT LIKE 'Legacy consolidation replay%'`, [mb, l.c, l.t]))[0]?.d;
                const silentMonths = last ? Math.floor((today.getTime() - new Date(last).getTime()) / (30.44 * 86400000)) : null;
                const principal = Number(q.outstandingPrincipal) || 0;
                const closure = Number(q.finalClosureAmount) || 0;
                const ratio = principal > 0 ? r2(closure / principal) : null;
                const reasons: string[] = [];
                if (ratio !== null && ratio > RATIO) reasons.push(`Closure amount is ${ratio} x the principal (limit ${RATIO})`);
                if (behind >= BEHIND) reasons.push(`${behind} instalments behind (limit ${BEHIND})`);
                if (silentMonths !== null && silentMonths >= SILENT) reasons.push(`No payment for ${silentMonths} months (limit ${SILENT})`);
                if (silentMonths === null) reasons.push('No payment recorded since the loan began');
                if ((Number(q.penalInterest) || 0) > principal && principal > 0) reasons.push('Penalty is larger than the unpaid principal');
                Object.assign(row, {
                    principal: r2(principal), nrInterest: r2(Number(q.nrInterest) || 0), apInterest: r2(Number(q.apInterest) || 0), penalty: r2(Number(q.penalInterest) || 0),
                    closure: r2(closure), ratio, instalmentsBehind: behind, lastPayment: last ? new Date(last).toISOString().slice(0, 10) : null, silentMonths,
                    verdict: reasons.length ? 'REVIEW' : 'OK', reasons,
                });
            } catch (e: any) {
                Object.assign(row, { verdict: 'ERROR', reasons: [`Closure could not be calculated: ${e?.message || e}`] });
            }
            out.push(row);
        }
        if ((i + 1) % 100 === 0) console.log(`  ${i + 1} / ${members.length} members`);
    }
    writeFileSync(join(__dirname, '..', '..', 'scripts', 'legacy-migration', 'reports', `outcome-sanity-${label}.json`), JSON.stringify(out, null, 1));
    const c = (v: string) => out.filter(o => o.verdict === v).length;
    console.log(`loans ${out.length}: OK ${c('OK')}, REVIEW ${c('REVIEW')}, ERROR ${c('ERROR')}`);
    const rc: Record<string, number> = {};
    for (const o of out) for (const r of o.reasons || []) { const k = r.replace(/[\d.]+/g, '#').slice(0, 60); rc[k] = (rc[k] || 0) + 1; }
    console.log(Object.entries(rc).sort((a, b) => b[1] - a[1]).map(([k, n]) => `  ${n}  ${k}`).join('\n'));
    await ds.destroy();
})().catch(e => { console.error(e.stack || e.message); process.exit(1); });
