import { AppDataSource } from '../config/database.config';
import { AddSameMonthPenalFields1755150300000 } from '../migrations/1755150300000-AddSameMonthPenalFields';

async function main() {
    await AppDataSource.initialize();
    const queryRunner = AppDataSource.createQueryRunner();
    await queryRunner.connect();
    try {
        const migration = new AddSameMonthPenalFields1755150300000();
        await migration.up(queryRunner);
        console.log('busrules.{rln,eln,aln}sm{pct,div} and loan_master.smpenal{pct,div} are in place.');
    } finally {
        await queryRunner.release();
        await AppDataSource.destroy();
    }
}

main().catch((err) => {
    console.error('Failed to apply migration:', err);
    process.exit(1);
});
