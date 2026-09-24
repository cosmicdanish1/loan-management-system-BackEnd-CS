/**
 * Read-only export: every real legacy loan, categorized and enriched, as CSV
 * inputs for the client-facing Excel workbook. Reuses the exact same
 * attribution engine as bulk_ledger_replay.ts (imported, not re-implemented)
 * so these numbers can never quietly diverge from what a real migration
 * would produce.
 *
 * Writes nothing to Postgres or SQL Server.
 */
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

const { findConsolidationEvents, buildAttribution, round2 } = require('./bulk_ledger_replay');

const SQLCMD_EXE = 'C:\\Program Files\\Microsoft SQL Server\\Client SDK\\ODBC\\170\\Tools\\Binn\\SQLCMD.EXE';
const SQLCMD_SERVER = '.\\SQLEXPRESS';
const SQLCMD_DB = 'EMP_Espat_Society_dan';
const ACTIVE_TOLERANCE = 50;
const ZERO_INTEREST_TOLERANCE = 1;

function sqlcmd(query: string): string[][] {
    const out = execFileSync(SQLCMD_EXE, [
        '-S', SQLCMD_SERVER, '-d', SQLCMD_DB, '-E', '-W', '-s', '|', '-h', '-1', '-Q', query,
    ], { encoding: 'utf-8', maxBuffer: 1024 * 1024 * 256 });
    return out.split('\n')
        .map(l => l.trimEnd())
        .filter(l => l.length > 0 && !/^-+(\|-+)*$/.test(l) && !/^\(\d+ rows? affected\)$/.test(l))
        .map(l => l.split('|').map(c => c.trim()));
}

const TYPE_LABEL: Record<string, string> = { ALN: 'Emergency Loan', RLN: 'Regular Loan' };

function csvEscape(v: any): string {
    const s = String(v ?? '');
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function writeCsv(filePath: string, header: string[], rows: any[][]) {
    const lines = [header.map(csvEscape).join(',')];
    for (const r of rows) lines.push(r.map(csvEscape).join(','));
    fs.writeFileSync(filePath, lines.join('\n'));
}

async function main() {
    console.log('Fetching bulk data from legacy...');
    const caseRows = sqlcmd(`SET NOCOUNT ON; SELECT MBNO, LOANCASENO, LOANTYPE, LOAN_AMT, BALANCE, NO_OF_INSTAL, INSTAL_AMT, CONVERT(varchar, PAYMENT_DATE, 120) FROM LOAN_MASTER WHERE LOANTYPE IN ('RLN','ALN') AND LOAN_AMT > 0 ORDER BY MBNO, PAYMENT_DATE;`);
    const eventRows = sqlcmd(`SET NOCOUNT ON; SELECT MBNO, TRANS_NO, CONVERT(varchar, TRANS_DATE, 120), TRANS_TYPE, ACC_TYPE, TRANS_AMT, RECEIPT_VCHR_NO, VCHR_TYPE FROM LEDGER WHERE ACC_TYPE IN ('RLN','ALN') ORDER BY MBNO, TRANS_DATE, TRANS_NO;`);
    const interestRows = sqlcmd(`SET NOCOUNT ON; SELECT MBNO, CONVERT(varchar, TRANS_DATE, 120), RECEIPT_VCHR_NO, TRANS_AMT FROM LEDGER WHERE CODE='I1002' AND TRANS_TYPE='CR' ORDER BY MBNO, TRANS_DATE;`);
    const nameRows = sqlcmd(`SET NOCOUNT ON; SELECT MBNO, LTRIM(RTRIM(ISNULL(f_name,'')+' '+ISNULL(m_name,'')+' '+ISNULL(l_name,''))) FROM member_master;`);
    console.log(`cases=${caseRows.length} events=${eventRows.length} interest=${interestRows.length} members=${nameRows.length}`);

    const nameByMbno = new Map<string, string>();
    for (const r of nameRows) nameByMbno.set(r[0], r[1]);

    const casesByMbno = new Map<string, any[]>();
    for (const r of caseRows) {
        const mbno = r[0];
        if (!casesByMbno.has(mbno)) casesByMbno.set(mbno, []);
        casesByMbno.get(mbno)!.push({ loancaseno: r[1], loantype: r[2], loanAmt: parseFloat(r[3]), balance: parseFloat(r[4]), noOfInstal: parseInt(r[5], 10), instalAmt: parseFloat(r[6]), paymentDate: r[7] });
    }
    const eventsByMbno = new Map<string, any[]>();
    for (const r of eventRows) {
        const mbno = r[0];
        if (!eventsByMbno.has(mbno)) eventsByMbno.set(mbno, []);
        eventsByMbno.get(mbno)!.push({ transNo: r[1], transDate: r[2], transType: r[3], accType: r[4], amt: parseFloat(r[5]), interestAmt: 0, receiptVchrNo: r[6], vchrType: r[7] });
    }
    const interestByMbno = new Map<string, any[]>();
    for (const r of interestRows) {
        const mbno = r[0];
        if (!interestByMbno.has(mbno)) interestByMbno.set(mbno, []);
        interestByMbno.get(mbno)!.push({ transDate: r[1], receiptVchrNo: r[2], amt: parseFloat(r[3]) });
    }

    console.log(`Running attribution for ${casesByMbno.size} members...`);

    const activeNoProblem: any[][] = [];
    const activeHasProblem: any[][] = [];
    const dead: any[][] = [];

    let processed = 0, errors = 0;
    for (const [mbno, cases] of casesByMbno) {
        processed++;
        if (processed % 1000 === 0) console.log(`  ...${processed}/${casesByMbno.size}`);
        try {
            const events = eventsByMbno.get(mbno) || [];
            const interestLegs = interestByMbno.get(mbno) || [];
            for (const leg of interestLegs) {
                const matches = events.filter((e: any) => e.transType === 'CR' && e.transDate === leg.transDate && e.receiptVchrNo === leg.receiptVchrNo);
                if (matches.length === 0) continue;
                const principalSum = matches.reduce((s: number, m: any) => s + m.amt, 0);
                if (principalSum <= 0) continue;
                for (const m of matches) m.interestAmt = round2(m.interestAmt + leg.amt * (m.amt / principalSum));
            }
            const consolidations = findConsolidationEvents(events);
            const { byType } = buildAttribution(cases, events, consolidations);
            const memberName = nameByMbno.get(mbno) || '';

            for (const type of ['ALN', 'RLN']) {
                const group: any[] = byType[type] || [];
                const activeInType = group.filter((cs: any) => !cs.closed && (cs.finalRemainingPrincipal ?? 0) > ACTIVE_TOLERANCE);
                const hasProblem = activeInType.length > 1;

                for (const cs of group) {
                    const lc = cs.legacyCase;
                    const isActive = !cs.closed && (cs.finalRemainingPrincipal ?? 0) > ACTIVE_TOLERANCE;
                    const totalPaid = round2((cs.repaymentsToReplay || []).reduce((s: number, r: any) => s + r.amount, 0));
                    const zeroInterestEmi = lc.noOfInstal > 0 && Math.abs(lc.instalAmt - lc.loanAmt / lc.noOfInstal) < ZERO_INTEREST_TOLERANCE;

                    const row = [
                        mbno, memberName, TYPE_LABEL[type] || type, lc.loancaseno,
                        lc.loanAmt, lc.noOfInstal, lc.instalAmt, lc.paymentDate,
                        isActive ? round2(cs.finalRemainingPrincipal) : 0,
                        lc.balance, totalPaid,
                        zeroInterestEmi ? 'YES' : 'No',
                    ];

                    if (!isActive) {
                        dead.push([...row, cs.closed ? `Closed / consolidated into ${cs.consolidatedInto || 'another case'}` : 'Fully repaid']);
                    } else if (hasProblem) {
                        activeHasProblem.push([...row, activeInType.length, '', '', '']);
                    } else {
                        activeNoProblem.push([...row, '', '', '']);
                    }
                }
            }
        } catch (e: any) {
            errors++;
            if (errors <= 10) console.log(`  ERROR for ${mbno}: ${e.message}`);
        }
    }

    console.log(`\nActive, no problem: ${activeNoProblem.length}`);
    console.log(`Active, has problem: ${activeHasProblem.length}`);
    console.log(`Dead/inactive: ${dead.length}`);
    console.log(`Errors: ${errors}`);

    const baseHeader = ['Member ID', 'Member Name', 'Loan Type', 'Loan Case No', 'Original Loan Amount (Legacy)', 'No of Installments', 'Legacy EMI Amount', 'Disbursement Date', 'Real Balance Remaining (Computed)', "Legacy's Own Balance Field (Not Reliable)", 'Real Total Paid So Far (Principal + Interest)', 'EMI Has No Interest Built In?'];

    const outDir = path.join(__dirname, '../../../scripts/legacy-migration/reports/full-loan-book-csv');
    fs.mkdirSync(outDir, { recursive: true });

    writeCsv(path.join(outDir, '1_active_no_problem.csv'), [...baseHeader, 'Books Show Balance', 'Matches? (Y/N)', 'Notes'], activeNoProblem);
    writeCsv(path.join(outDir, '2_active_has_problem.csv'), [...baseHeader, 'Active Loans of This Type for Member', 'Books Show Balance', 'Matches? (Y/N)', 'Notes'], activeHasProblem);
    writeCsv(path.join(outDir, '3_dead_inactive.csv'), [...baseHeader, 'Status'], dead);

    console.log(`\nCSVs written to ${outDir}`);
}
main().catch(e => { console.error(e); process.exit(1); });
