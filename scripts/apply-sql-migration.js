// One-off SQL migration runner (the TypeORM migrations table is out of sync, so
// `npm run migration:run` is not used). Usage:
//   node scripts/apply-sql-migration.js database/migrations/create-loan-reagreements.sql
const fs = require('fs');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const { Client } = require('pg');

(async () => {
    const file = process.argv[2];
    if (!file) { console.error('usage: node scripts/apply-sql-migration.js <file.sql>'); process.exit(1); }
    const sql = fs.readFileSync(path.resolve(file), 'utf8');
    const client = new Client({
        host: process.env.DB_HOST || 'localhost',
        port: parseInt(process.env.DB_PORT || '5432', 10),
        user: process.env.DB_USERNAME,
        password: process.env.DB_PASSWORD,
        database: process.env.DB_DATABASE,
    });
    await client.connect();
    try {
        await client.query('BEGIN');
        await client.query(sql);
        await client.query('COMMIT');
        console.log('Applied:', file);
    } catch (e) {
        await client.query('ROLLBACK');
        console.error('FAILED, rolled back:', e.message);
        process.exitCode = 1;
    } finally {
        await client.end();
    }
})();
