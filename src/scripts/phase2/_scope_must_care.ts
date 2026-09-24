/**
 * Read-only: classifies every real legacy loan case into "must take care of
 * during migration" (currently active, OR a real predecessor feeding an
 * active case's balance via consolidation) vs "can ignore" (dead end, no
 * active descendant). Reuses the exact same attribution engine as
 * bulk_ledger_replay.ts. Writes nothing.
 */
import { execFileSync } from 'child_process';

const { findConsolidationEvents, findPvoucherConsolidations, buildAttribution } = require('./bulk_ledger_replay');

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
    // Active = has demand this billing period (Aug 2026), per the report's own definition.
    const activeRows = sqlcmd(`SET NOCOUNT ON; SELECT MBNO, RLN_AMOUNT, ALN_AMOUNT FROM DEMAND_MASTER WHERE DEMAND_FOR_YEAR=2026 AND DEMAND_FOR_MONTH=8 AND (RLN_AMOUNT>0 OR ALN_AMOUNT>0);`);
    console.log(`cases=${caseRows.length} events=${eventRows.length} interest=${interestRows.length} active_members=${activeRows.length}`);

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

    console.log(`Running attribution for ${casesByMbno.size} members...`);

    let mustCareRLN = 0, mustCareALN = 0, ignoreRLN = 0, ignoreALN = 0;
    let activeStandaloneRLN = 0, activeStandaloneALN = 0, activeConsolidatedRLN = 0, activeConsolidatedALN = 0;
    let predecessorRLN = 0, predecessorALN = 0;
    let processed = 0;

    for (const [mbno, cases] of casesByMbno) {
        processed++;
        if (processed % 2000 === 0) console.log(`  ...${processed}/${casesByMbno.size}`);
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
                const group: any[] = byType[type] || [];
                if (group.length === 0) continue;

                // Find the currently-open (non-closed, real remaining principal) case(s) for this
                // member+type — the "head" of each chain. If the member has demand this type,
                // treat every non-closed case as active (usually exactly one; can be more for the
                // genuinely-unresolved-concurrent-loan members already investigated this session).
                const isActiveType = activeTypes.has(type);
                const openCases = group.filter((cs: any) => !cs.closed);

                // Walk backward from each open/active case through consolidatedFromCase chains
                // (closed cases whose consolidation event resolved INTO this case, transitively) —
                // those predecessors matter for computing the active case's real balance even
                // though the predecessor itself is closed/non-active.
                const caseByNo = new Map<string, any>();
                for (const cs of group) caseByNo.set(cs.legacyCase.loancaseno, cs);
                const resolvedFrom = new Map<string, string>(); // loancaseno -> loancaseno it closed INTO
                for (const cons of consolidations) {
                    if (cons.resolvedFromCase && cons.resolvedToCase) resolvedFrom.set(cons.resolvedFromCase, cons.resolvedToCase);
                }
                const predecessorsOf = new Map<string, string[]>();
                for (const [from, to] of resolvedFrom) {
                    if (!predecessorsOf.has(to)) predecessorsOf.set(to, []);
                    predecessorsOf.get(to)!.push(from);
                }

                const mustCare = new Set<string>();
                if (isActiveType) {
                    for (const cs of openCases) {
                        const no = cs.legacyCase.loancaseno;
                        mustCare.add(no);
                        // BFS backward through the chain
                        const stack = [no];
                        while (stack.length) {
                            const cur = stack.pop()!;
                            for (const pred of predecessorsOf.get(cur) || []) {
                                if (!mustCare.has(pred)) { mustCare.add(pred); stack.push(pred); }
                            }
                        }
                    }
                }

                for (const cs of group) {
                    const no = cs.legacyCase.loancaseno;
                    const care = mustCare.has(no);
                    if (type === 'RLN') { if (care) mustCareRLN++; else ignoreRLN++; }
                    else { if (care) mustCareALN++; else ignoreALN++; }
                }

                if (isActiveType) {
                    for (const cs of openCases) {
                        const no = cs.legacyCase.loancaseno;
                        const hasPredecessor = (predecessorsOf.get(no) || []).length > 0;
                        if (type === 'RLN') { if (hasPredecessor) activeConsolidatedRLN++; else activeStandaloneRLN++; }
                        else { if (hasPredecessor) activeConsolidatedALN++; else activeStandaloneALN++; }
                    }
                }
                const predCount = mustCare.size - openCases.filter((cs: any) => isActiveType).length;
                if (type === 'RLN') predecessorRLN += Math.max(0, predCount); else predecessorALN += Math.max(0, predCount);
            }
        } catch (e: any) {
            console.log(`ERROR ${mbno}: ${e.message}`);
        }
    }

    console.log('\n===== RESULTS =====');
    console.log(`RLN — must take care: ${mustCareRLN}, can ignore: ${ignoreRLN}`);
    console.log(`ALN — must take care: ${mustCareALN}, can ignore: ${ignoreALN}`);
    console.log(`Total — must take care: ${mustCareRLN + mustCareALN}, can ignore: ${ignoreRLN + ignoreALN}`);
    console.log(`\nActive standalone (no predecessor): RLN=${activeStandaloneRLN} ALN=${activeStandaloneALN}`);
    console.log(`Active consolidated (has predecessor): RLN=${activeConsolidatedRLN} ALN=${activeConsolidatedALN}`);
    console.log(`Predecessor (closed) cases feeding an active case: RLN=${predecessorRLN} ALN=${predecessorALN}`);
}
main().catch(e => { console.error(e); process.exit(1); });
