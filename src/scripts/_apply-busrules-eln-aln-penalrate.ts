import { AppDataSource } from '../config/database.config';
import { AddBusRulesElnAlnPenalRate1755150100000 } from '../migrations/1755150100000-AddBusRulesElnAlnPenalRate';

async function main() {
    await AppDataSource.initialize();
    const queryRunner = AppDataSource.createQueryRunner();
    await queryRunner.connect();
    try {
        const migration = new AddBusRulesElnAlnPenalRate1755150100000();
        await migration.up(queryRunner);
        console.log('busrules: elnpenalrate, alnpenalrate columns are in place.');
    } finally {
        await queryRunner.release();
        await AppDataSource.destroy();
    }
}

main().catch((err) => {
    console.error('Failed to apply migration:', err);
    process.exit(1);
});
