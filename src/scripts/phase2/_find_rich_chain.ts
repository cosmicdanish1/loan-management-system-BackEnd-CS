/** Read-only: finds ALN members with the LONGEST consolidation chain where
 *  EVERY link is a near-exact match (real predecessor remaining ≈ implied
 *  prior debt), for a "rich data, still perfect" demo example. */
import { execFileSync } from 'child_process';
const { findConsolidationEvents, findPvoucherConsolidations, buildAttribution, round2 } = require('./bulk_ledger_replay');

const SQLCMD_EXE = 'C:\\Program Files\\Microsoft SQL Server\\Client SDK\\ODBC\\170\\Tools\\Binn\\SQLCMD.EXE';
function sqlcmd(query: string): string[][] {
    const out = execFileSync(SQLCMD_EXE, ['-S', '.\\SQLEXPRESS', '-d', 'EMP_Espat_Society_dan', '-E', '-W', '-s', '|', '-h', '-1', '-Q', query], { encoding: 'utf-8', maxBuffer: 1024 * 1024 * 256 });
    return out.split('\n').map(l => l.trimEnd()).filter(l => l.length > 0 && !/^-+(\|-+)*$/.test(l) && !/^\(\d+ rows? affected\)$/.test(l)).map(l => l.split('|').map(c => c.trim()));
}

async function main() {
    console.log('Fetching...');
    const caseRows = sqlcmd(`SET NOCOUNT ON; SELECT MBNO, LOANCASENO, LOANTYPE, LOAN_AMT, BALANCE, NO_OF_INSTAL, INSTAL_AMT, CONVERT(varchar, PAYMENT_DATE, 120) FROM LOAN_MASTER WHERE LOANTYPE IN ('RLN','ALN') AND LOAN_AMT > 0 ORDER BY MBNO, PAYMENT_DATE;`);
    const eventRows = sqlcmd(`SET NOCOUNT ON; SELECT MBNO, TRANS_NO, CONVERT(varchar, TRANS_DATE, 120), TRANS_TYPE, ACC_TYPE, TRANS_AMT, RECEIPT_VCHR_NO, VCHR_TYPE, PL_BALANCE FROM LEDGER WHERE ACC_TYPE IN ('RLN','ALN') ORDER BY MBNO, TRANS_DATE, TRANS_NO;`);
    const interestRows = sqlcmd(`SET NOCOUNT ON; SELECT MBNO, CONVERT(varchar, TRANS_DATE, 120), RECEIPT_VCHR_NO, TRANS_AMT FROM LEDGER WHERE CODE='I1002' AND TRANS_TYPE='CR' ORDER BY MBNO, TRANS_DATE;`);
    const activeRows = sqlcmd(`SET NOCOUNT ON; SELECT MBNO, RLN_AMOUNT, ALN_AMOUNT FROM DEMAND_MASTER WHERE DEMAND_FOR_YEAR=2026 AND DEMAND_FOR_MONTH=8 AND (RLN_AMOUNT>0 OR ALN_AMOUNT>0);`);
    const nameRows = sqlcmd(`SET NOCOUNT ON; SELECT MBNO, LTRIM(RTRIM(ISNULL(f_name,'')+' '+ISNULL(m_name,'')+' '+ISNULL(l_name,''))) FROM member_master;`);
    const nameByMbno = new Map<string, string>(); for (const r of nameRows) nameByMbno.set(r[0], r[1]);
    const activeTypesByMbno = new Map<string, Set<string>>();
    for (const r of activeRows) { const s = activeTypesByMbno.get(r[0]) || new Set<string>(); if (parseFloat(r[1]) > 0) s.add('RLN'); if (parseFloat(r[2]) > 0) s.add('ALN'); activeTypesByMbno.set(r[0], s); }
    const casesByMbno = new Map<string, any[]>();
    for (const r of caseRows) { const m = r[0]; if (!casesByMbno.has(m)) casesByMbno.set(m, []); casesByMbno.get(m)!.push({ loancaseno: r[1], loantype: r[2], loanAmt: parseFloat(r[3]), balance: parseFloat(r[4]), noOfInstal: parseInt(r[5], 10), instalAmt: parseFloat(r[6]), paymentDate: r[7] }); }
    const eventsByMbno = new Map<string, any[]>();
    for (const r of eventRows) { const m = r[0]; if (!eventsByMbno.has(m)) eventsByMbno.set(m, []); eventsByMbno.get(m)!.push({ transNo: r[1], transDate: r[2], transType: r[3], accType: r[4], amt: parseFloat(r[5]), interestAmt: 0, receiptVchrNo: r[6], vchrType: r[7], plBalance: r[8] ? parseFloat(r[8]) : undefined }); }
    const interestByMbno = new Map<string, any[]>();
    for (const r of interestRows) { const m = r[0]; if (!interestByMbno.has(m)) interestByMbno.set(m, []); interestByMbno.get(m)!.push({ transDate: r[1], receiptVchrNo: r[2], amt: parseFloat(r[3]) }); }

    console.log(`Scanning ${casesByMbno.size} members for the longest clean ALN chain...`);
    type Result = { mbno: string; name: string; chainLen: number; totalRepayments: number; finalCase: string; finalBalance: number; maxDiff: number; chain: string[] };
    const results: Result[] = [];

    for (const [mbno, cases] of casesByMbno) {
        try {
            const events = eventsByMbno.get(mbno) || [];
            const interestLegs = interestByMbno.get(mbno) || [];
            for (const leg of interestLegs) {
                const matches = events.filter((e: any) => e.transType === 'CR' && e.transDate === leg.transDate && e.receiptVchrNo === leg.receiptVchrNo);
                if (matches.length === 0) continue;
                const sum = matches.reduce((s: number, m: any) => s + m.amt, 0);
                if (sum <= 0) continue;
                for (const m of matches) m.interestAmt = (m.interestAmt || 0) + leg.amt * (m.amt / sum);
            }
            const consolidations = [...findConsolidationEvents(events), ...findPvoucherConsolidations(cases, events)].sort((a: any, b: any) => a.date.localeCompare(b.date));
            const { byType } = buildAttribution(cases, events, consolidations);
            const activeTypes = activeTypesByMbno.get(mbno) || new Set<string>();
            if (!activeTypes.has('ALN')) continue;
            const group: any[] = byType['ALN'] || [];
            const openCases = group.filter((cs: any) => !cs.closed);
            if (openCases.length !== 1) continue;
            const active = openCases[0];

            // Walk the chain backward, requiring EVERY link near-exact.
            const caseByNo = new Map<string, any>(); for (const cs of group) caseByNo.set(cs.legacyCase.loancaseno, cs);
            const consByTo = new Map<string, any>(); for (const c of consolidations) if (c.resolvedToCase && c.toHead === 'ALN' && caseByNo.has(c.resolvedFromCase)) consByTo.set(c.resolvedToCase, c);

            let cur = active.legacyCase.loancaseno;
            const chain: string[] = [cur];
            let maxDiff = 0;
            let clean = true;
            while (consByTo.has(cur)) {
                const c = consByTo.get(cur);
                const pred = caseByNo.get(c.resolvedFromCase);
                const diff = round2(Math.abs(c.amt - (pred.finalRemainingPrincipal ?? 0)));
                maxDiff = Math.max(maxDiff, diff);
                if (diff > 10) { clean = false; break; }
                chain.push(c.resolvedFromCase);
                cur = c.resolvedFromCase;
            }
            if (!clean || chain.length < 2) continue;

            const totalRepayments = group.reduce((s: number, cs: any) => s + (cs.repaymentsToReplay || []).length, 0);
            results.push({ mbno, name: nameByMbno.get(mbno) || '', chainLen: chain.length, totalRepayments, finalCase: active.legacyCase.loancaseno, finalBalance: round2(active.finalRemainingPrincipal ?? 0), maxDiff, chain });
        } catch (e) { /* skip */ }
    }

    results.sort((a, b) => b.chainLen - a.chainLen || b.totalRepayments - a.totalRepayments);
    console.log(`\nFound ${results.length} clean multi-hop ALN chains. Top 10 by chain length:\n`);
    for (const r of results.slice(0, 10)) {
        console.log(`${r.mbno} (${r.name}) — chain length ${r.chainLen} (${r.chain.join(' -> ')}), ${r.totalRepayments} total repayments, final case #${r.finalCase} balance ₹${r.finalBalance}, max link diff ₹${r.maxDiff}`);
    }
}
main().catch(e => { console.error(e); process.exit(1); });
