/**
 * Read-only: finds "perfect" consolidation examples for client demo — active
 * loans that absorbed exactly one predecessor, where the implied prior debt
 * (PL_BALANCE - TRANS_AMT) matches the predecessor's real computed remaining
 * principal almost exactly, and no overflow/schedule-extension anomaly
 * occurred anywhere in the chain. Writes nothing.
 */
import { execFileSync } from 'child_process';

const { findConsolidationEvents, findPvoucherConsolidations, buildAttribution, round2 } = require('./bulk_ledger_replay');

const SQLCMD_EXE = 'C:\\Program Files\\Microsoft SQL Server\\Client SDK\\ODBC\\170\\Tools\\Binn\\SQLCMD.EXE';
const SQLCMD_SERVER = '.\\SQLEXPRESS';
const SQLCMD_DB = 'EMP_Espat_Society_dan';

function sqlcmd(query: string): string[][] {
    const out = execFileSync(SQLCMD_EXE, [
        '-S', SQLCMD_SERVER, '-d', SQLCMD_DB, '-E', '-W', '-s', '|', '-h', '-1', '-Q', query,
    ], { encoding: 'utf-8', maxBuffer: 1024 * 1024 * 256 });
    return out.split('\n')
        .map(l => l.trimEnd())
        .filter(l => l.length > 0 && !/^-+(\|-+)*$/.test(l) && !/^\(\d+ rows? affected\)$/.test(l))
        .map(l => l.split('|').map(c => c.trim()));
}

async function main() {
    console.log('Fetching bulk data...');
    const caseRows = sqlcmd(`SET NOCOUNT ON; SELECT MBNO, LOANCASENO, LOANTYPE, LOAN_AMT, BALANCE, NO_OF_INSTAL, INSTAL_AMT, CONVERT(varchar, PAYMENT_DATE, 120) FROM LOAN_MASTER WHERE LOANTYPE IN ('RLN','ALN') AND LOAN_AMT > 0 ORDER BY MBNO, PAYMENT_DATE;`);
    const eventRows = sqlcmd(`SET NOCOUNT ON; SELECT MBNO, TRANS_NO, CONVERT(varchar, TRANS_DATE, 120), TRANS_TYPE, ACC_TYPE, TRANS_AMT, RECEIPT_VCHR_NO, VCHR_TYPE, PL_BALANCE FROM LEDGER WHERE ACC_TYPE IN ('RLN','ALN') ORDER BY MBNO, TRANS_DATE, TRANS_NO;`);
    const interestRows = sqlcmd(`SET NOCOUNT ON; SELECT MBNO, CONVERT(varchar, TRANS_DATE, 120), RECEIPT_VCHR_NO, TRANS_AMT FROM LEDGER WHERE CODE='I1002' AND TRANS_TYPE='CR' ORDER BY MBNO, TRANS_DATE;`);
    const activeRows = sqlcmd(`SET NOCOUNT ON; SELECT MBNO, RLN_AMOUNT, ALN_AMOUNT FROM DEMAND_MASTER WHERE DEMAND_FOR_YEAR=2026 AND DEMAND_FOR_MONTH=8 AND (RLN_AMOUNT>0 OR ALN_AMOUNT>0);`);
    const nameRows = sqlcmd(`SET NOCOUNT ON; SELECT MBNO, LTRIM(RTRIM(ISNULL(f_name,'')+' '+ISNULL(m_name,'')+' '+ISNULL(l_name,''))) FROM member_master;`);
    console.log(`cases=${caseRows.length} events=${eventRows.length} interest=${interestRows.length} active_members=${activeRows.length}`);

    const nameByMbno = new Map<string, string>();
    for (const r of nameRows) nameByMbno.set(r[0], r[1]);

    const activeTypesByMbno = new Map<string, Set<string>>();
    for (const r of activeRows) {
        const mbno = r[0];
        const set = activeTypesByMbno.get(mbno) || new Set<string>();
        if (parseFloat(r[1]) > 0) set.add('RLN');
        if (parseFloat(r[2]) > 0) set.add('ALN');
        activeTypesByMbno.set(mbno, set);
    }

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
        eventsByMbno.get(mbno)!.push({ transNo: r[1], transDate: r[2], transType: r[3], accType: r[4], amt: parseFloat(r[5]), interestAmt: 0, receiptVchrNo: r[6], vchrType: r[7], plBalance: r[8] ? parseFloat(r[8]) : undefined });
    }
    const interestByMbno = new Map<string, any[]>();
    for (const r of interestRows) {
        const mbno = r[0];
        if (!interestByMbno.has(mbno)) interestByMbno.set(mbno, []);
        interestByMbno.get(mbno)!.push({ transDate: r[1], receiptVchrNo: r[2], amt: parseFloat(r[3]) });
    }

    console.log(`Scanning ${casesByMbno.size} members for perfect single-hop examples...`);

    type Candidate = {
        mbno: string; name: string; type: string;
        oldCase: string; newCase: string;
        oldBalance: number; newLoanAmt: number; combined: number;
        newInstalAmt: number; matchDiff: number;
    };
    const candidates: Candidate[] = [];

    for (const [mbno, cases] of casesByMbno) {
        try {
            const events = eventsByMbno.get(mbno) || [];
            const interestLegs = interestByMbno.get(mbno) || [];
            for (const leg of interestLegs) {
                const matches = events.filter((e: any) => e.transType === 'CR' && e.transDate === leg.transDate && e.receiptVchrNo === leg.receiptVchrNo);
                if (matches.length === 0) continue;
                const principalSum = matches.reduce((s: number, m: any) => s + m.amt, 0);
                if (principalSum <= 0) continue;
                for (const m of matches) m.interestAmt = (m.interestAmt || 0) + leg.amt * (m.amt / principalSum);
            }
            const consolidations = [...findConsolidationEvents(events), ...findPvoucherConsolidations(cases, events)]
                .sort((a: any, b: any) => a.date.localeCompare(b.date));
            const { byType } = buildAttribution(cases, events, consolidations);
            const activeTypes = activeTypesByMbno.get(mbno) || new Set<string>();

            for (const type of ['RLN', 'ALN']) {
                if (!activeTypes.has(type)) continue;
                const group: any[] = byType[type] || [];
                const openCases = group.filter((cs: any) => !cs.closed);
                if (openCases.length !== 1) continue; // only single, unambiguous active case for this type
                const active = openCases[0];

                // Exactly one predecessor closing into this active case.
                const cons = consolidations.filter((c: any) => c.resolvedToCase === active.legacyCase.loancaseno && c.toHead === type);
                if (cons.length !== 1) continue;
                const closedCaseNo = cons[0].resolvedFromCase;
                if (!closedCaseNo) continue;
                const closedCase = group.find((cs: any) => cs.legacyCase.loancaseno === closedCaseNo);
                if (!closedCase) continue;

                // Only one predecessor in the whole chain (a clean single hop, not a long chain)
                const totalPredecessors = consolidations.filter((c: any) =>
                    group.some((cs: any) => cs.legacyCase.loancaseno === c.resolvedFromCase)).length;
                if (totalPredecessors !== 1) continue;

                const impliedPrior = round2(cons[0].amt);
                const realRemaining = round2(closedCase.finalRemainingPrincipal ?? 0);
                const matchDiff = round2(Math.abs(impliedPrior - realRemaining));
                if (matchDiff > 5) continue; // near-exact only

                // No overflow anomaly on the active case itself.
                const totalReplay = round2((active.repaymentsToReplay || []).reduce((s: number, r: any) => s + r.amount, 0));
                const capacity = round2(active.legacyCase.loanAmt + active.toppedUpBy);
                if (totalReplay > capacity + 5) continue;

                candidates.push({
                    mbno, name: nameByMbno.get(mbno) || '', type,
                    oldCase: closedCaseNo, newCase: active.legacyCase.loancaseno,
                    oldBalance: realRemaining, newLoanAmt: round2(active.legacyCase.loanAmt),
                    combined: capacity, newInstalAmt: active.legacyCase.instalAmt, matchDiff,
                });
            }
        } catch (e: any) { /* skip anomalous members */ }
    }

    candidates.sort((a, b) => a.matchDiff - b.matchDiff);
    const rln = candidates.filter(c => c.type === 'RLN');
    const aln = candidates.filter(c => c.type === 'ALN');
    console.log(`\nFound ${candidates.length} perfect single-hop candidates (${rln.length} RLN, ${aln.length} ALN).`);
    console.log(`\n--- RLN, top 10 ---`);
    for (const c of rln.slice(0, 10)) {
        console.log(`${c.mbno} (${c.name}) [${c.type}] — old #${c.oldCase} (real remaining ₹${c.oldBalance}) + new #${c.newCase} sanctioned ₹${c.newLoanAmt} = combined ₹${c.combined}, match diff ₹${c.matchDiff}`);
    }
    console.log(`\n--- ALN, top 10 ---`);
    for (const c of aln.slice(0, 10)) {
        console.log(`${c.mbno} (${c.name}) [${c.type}] — old #${c.oldCase} (real remaining ₹${c.oldBalance}) + new #${c.newCase} sanctioned ₹${c.newLoanAmt} = combined ₹${c.combined}, match diff ₹${c.matchDiff}`);
    }
}
main().catch(e => { console.error(e); process.exit(1); });
