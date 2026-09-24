import { DataSource } from 'typeorm';

// Fixes the 27 placeholder (loan_amt=0) RLN rows whose balance was silently
// hijacked to copy the colliding real ALN case's balance — see the
// before/after reconstruction done this session. Only touches rows matching
// the exact confirmed (mbno, loancaseno) pairs, loantype='RLN', loan_amt=0 —
// the same double-guard used in the reconstruction query, so this can't
// accidentally touch a real loan even if the pair list has an error.
const AppDataSource = new DataSource({
    type: 'postgres', host: 'localhost', port: 5432, database: 'EMP_Espat_Society',
    username: 'postgres', password: 'Test@1212',
    entities: [__dirname + '/../../**/*.entity{.ts,.js}'], synchronize: false, logging: false,
});

const PAIRS: [string, string][] = [
    ['30020194', '31'], ['30020860', '44'], ['30021377', '53'], ['30021399', '54'], ['30022060', '58'],
    ['30022363', '66'], ['30023346', '90'], ['30023549', '93'], ['30023704', '103'], ['30023773', '105'],
    ['30023891', '110'], ['30029087', '171'], ['30029192', '173'], ['30029587', '188'], ['30030378', '192'],
    ['30030436', '196'], ['30030586', '204'], ['30030754', '218'], ['30030825', '223'], ['30030980', '230'],
    ['30031051', '232'], ['30031298', '243'], ['30031688', '254'], ['30031691', '256'], ['30032556', '257'],
    ['610024919', '119'], ['610027906', '153'],
];

async function main() {
    await AppDataSource.initialize();
    const runner = AppDataSource.createQueryRunner();
    await runner.connect();
    await runner.startTransaction();
    try {
        let fixed = 0;
        for (const [mbno, loancaseno] of PAIRS) {
            const before = await runner.query(
                `SELECT balance FROM loan_master WHERE mbno=$1 AND loancaseno::text=$2 AND loantype='RLN' AND loan_amt=0`,
                [mbno, loancaseno]
            );
            if (before.length !== 1) {
                console.log(`SKIP ${mbno}/${loancaseno}: expected exactly 1 matching placeholder row, found ${before.length}`);
                continue;
            }
            const result = await runner.query(
                `UPDATE loan_master SET balance = 0 WHERE mbno=$1 AND loancaseno::text=$2 AND loantype='RLN' AND loan_amt=0`,
                [mbno, loancaseno]
            );
            console.log(`Fixed ${mbno}/${loancaseno}: balance ${before[0].balance} -> 0`);
            fixed++;
        }
        await runner.commitTransaction();
        console.log(`\nDone. Fixed ${fixed} of ${PAIRS.length} pairs.`);
    } catch (e) {
        await runner.rollbackTransaction();
        throw e;
    } finally {
        await runner.release();
        await AppDataSource.destroy();
    }
}

main().catch((e) => { console.error(e); process.exit(1); });
