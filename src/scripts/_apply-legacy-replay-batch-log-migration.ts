import { DataSource } from 'typeorm';
import { AddLegacyReplayBatchLog1759100000000 } from '../migrations/1759100000000-AddLegacyReplayBatchLog';

// Same standalone-credential workaround as every other one-off script this
// session — AppDataSource (config/database.config.ts) needs the full Nest
// bootstrap's dotenv load, which a bare ts-node script never triggers.
const AppDataSource = new DataSource({
    type: 'postgres', host: 'localhost', port: 5432, database: 'EMP_Espat_Society',
    username: 'postgres', password: 'Test@1212',
    entities: [__dirname + '/../**/*.entity{.ts,.js}'], synchronize: false, logging: false,
});

async function main() {
    await AppDataSource.initialize();
    const queryRunner = AppDataSource.createQueryRunner();
    await queryRunner.connect();
    try {
        const migration = new AddLegacyReplayBatchLog1759100000000();
        await migration.up(queryRunner);
        console.log('legacy_replay_batch_log table is in place.');
    } finally {
        await queryRunner.release();
        await AppDataSource.destroy();
    }
}

main().catch((err) => {
    console.error('Failed to apply migration:', err);
    process.exit(1);
});
