import { execFileSync } from 'child_process';
import { readFileSync } from 'fs';
import { DataSource } from 'typeorm';

// Cleans up after the repeated-retry duplication found on the 1,567-member
// flagged batch: any member that stayed 'failed' across multiple runs got
// reprocessed from scratch every time, and since the attribution logic
// itself changed between runs (natural-payoff cursor fix, schedule
// extension fix), each retry posted a different, overlapping slice of the
// same real money without any awareness of what an earlier attempt had
// already committed. Confirmed concretely on 610024208/case 11408: ₹60,000
// more was posted than this member's entire real ALN history could ever
// produce.
//
// Fix: don't try to forensically untangle which specific postings are
// legitimate. Reset every loan_master row for these 1,567 members back to
// its true legacy-sourced state (loan_amt, no_of_instal — the only fields
// this migration ever modifies besides balance), delete every repayment
// row this migration ever posted for them, and clear their batch-log
// entries so the next run treats them as never attempted. The 2,075-member
// clean batch is NOT touched — its failure pattern (fail immediately with
// zero writes, or succeed cleanly once) was independently verified safe.

const AppDataSource = new DataSource({
    type: 'postgres', host: 'localhost', port: 5432, database: 'EMP_Espat_Society',
    username: 'postgres', password: 'Test@1212',
    entities: [__dirname + '/../../**/*.entity{.ts,.js}'], synchronize: false, logging: false,
});

const MEMBER_FILE = process.env.WIPE_MEMBER_FILE || 'src/scripts/phase2/flagged_members_1567.txt';
const REPLAY_NARRATIONS = [
    'Legacy ledger replay (Phase 2 bulk migration)',
    'Legacy consolidation replay: closed, folded into successor case',
];

function sqlcmd(query: string): string[][] {
    const out = execFileSync('sqlcmd', [
        '-S', '.\\SQLEXPRESS', '-d', 'EMP_Espat_Society_dan', '-E', '-W', '-s', '|', '-h', '-1', '-Q', query,
    ], { encoding: 'utf-8', maxBuffer: 1024 * 1024 * 64 });
    return out.split('\n')
        .map(l => l.trimEnd())
        .filter(l => l.length > 0 && !/^-+(\|-+)*$/.test(l) && !/^\(\d+ rows? affected\)$/.test(l))
        .map(l => l.split('|').map(c => c.trim()));
}

function assertSafeMbno(mbno: string): void {
    if (!/^[0-9]{1,20}$/.test(mbno)) throw new Error(`Refusing unsafe MBNO: ${JSON.stringify(mbno)}`);
}

async function main() {
    const members = readFileSync(MEMBER_FILE, 'utf-8').split(/\r?\n/).map(m => m.trim()).filter(Boolean);
    console.log(`Wiping and resetting ${members.length} flagged-batch members...`);

    await AppDataSource.initialize();

    let membersReset = 0, casesReset = 0, ledgerRowsDeleted = 0, batchLogCleared = 0;

    for (const mbno of members) {
        assertSafeMbno(mbno);
        const runner = AppDataSource.createQueryRunner();
        await runner.connect();
        await runner.startTransaction();
        try {
            const legacyCases = sqlcmd(`
                SET NOCOUNT ON;
                SELECT LOANCASENO, LOANTYPE, LOAN_AMT, NO_OF_INSTAL
                FROM LOAN_MASTER WHERE MBNO='${mbno}' AND LOANTYPE IN ('RLN','ALN');
            `).map(r => ({ loancaseno: r[0], loantype: r[1], loanAmt: parseFloat(r[2]), noOfInstal: parseInt(r[3], 10) }));

            for (const c of legacyCases) {
                const result = await runner.query(
                    `UPDATE loan_master
                     SET loan_amt = $1, no_of_instal = $2, balance = $1,
                         consolidated_into_loancaseno = NULL,
                         payroll_lag_watch_until = NULL, payroll_lag_old_principal = NULL, payroll_lag_old_interest = NULL
                     WHERE mbno = $3 AND loancaseno::text = $4 AND loantype = $5`,
                    [c.loanAmt, c.noOfInstal, mbno, c.loancaseno, c.loantype]
                );
                casesReset++;
            }

            const toDelete = await runner.query(
                `SELECT count(*)::int as cnt FROM loan_repayment_ledger WHERE mbno = $1 AND narration = ANY($2)`,
                [mbno, REPLAY_NARRATIONS]
            );
            ledgerRowsDeleted += toDelete[0]?.cnt ?? 0;
            await runner.query(
                `DELETE FROM loan_repayment_ledger WHERE mbno = $1 AND narration = ANY($2)`,
                [mbno, REPLAY_NARRATIONS]
            );

            await runner.query(`DELETE FROM legacy_replay_batch_log WHERE mbno = $1`, [mbno]);
            batchLogCleared++;

            await runner.commitTransaction();
            membersReset++;
        } catch (e: any) {
            await runner.rollbackTransaction();
            console.error(`FAILED to reset ${mbno}: ${e.message}`);
        } finally {
            await runner.release();
        }
    }

    console.log(`\nDone. Members reset: ${membersReset}/${members.length}, cases reset: ${casesReset}, `
        + `batch log entries cleared: ${batchLogCleared}`);

    await AppDataSource.destroy();
}

main().catch((e) => { console.error(e); process.exit(1); });
