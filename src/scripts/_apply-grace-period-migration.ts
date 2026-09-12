import { AppDataSource } from '../config/database.config';
import { AddGracePeriodToLoans1755150200000 } from '../migrations/1755150200000-AddGracePeriodToLoans';

async function main() {
    await AppDataSource.initialize();
    const queryRunner = AppDataSource.createQueryRunner();
    await queryRunner.connect();
    try {
        const migration = new AddGracePeriodToLoans1755150200000();
        await migration.up(queryRunner);
        console.log('busrules.{rln,eln,aln}gracedays and loan_master.gracedays are in place.');
    } finally {
        await queryRunner.release();
        await AppDataSource.destroy();
    }
}

main().catch((err) => {
    console.error('Failed to apply migration:', err);
    process.exit(1);
});
