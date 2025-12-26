const { Client } = require('pg');

async function migrate() {
    const client = new Client({
        host: 'localhost', port: 5432, database: 'EMP_Espat_Society', user: 'postgres', password: 'Test@1212'
    });
    await client.connect();
    console.log('Connected to DB');

    try {
        // 1. Convert loan_pending columns from character varying to numeric
        console.log('Converting loan_pending columns...');

        // First, check if columns are already numeric or not
        const cols = await client.query(`
      SELECT column_name, data_type 
      FROM information_schema.columns 
      WHERE table_name = 'loan_pending' 
      AND column_name IN ('applied_amt', 'sanctioned_amt')
    `);

        for (const col of cols.rows) {
            if (col.data_type === 'character varying' || col.data_type === 'varchar' || col.data_type === 'text') {
                console.log(`Converting ${col.column_name}...`);
                // Clean values: remove non-numeric chars except dot
                await client.query(`UPDATE loan_pending SET "${col.column_name}" = REGEXP_REPLACE("${col.column_name}", '[^0-9.]', '', 'g') WHERE "${col.column_name}" IS NOT NULL`);
                // Handle empty strings
                await client.query(`UPDATE loan_pending SET "${col.column_name}" = '0' WHERE "${col.column_name}" = ''`);
                // Alter type
                await client.query(`ALTER TABLE loan_pending ALTER COLUMN "${col.column_name}" TYPE numeric(19, 4) USING "${col.column_name}"::numeric`);
            }
        }

        // 2. Convert money types to numeric in other relevant tables
        const moneyCols = await client.query(`
      SELECT table_name, column_name 
      FROM information_schema.columns 
      WHERE table_schema = 'public' AND data_type = 'money' 
      AND table_name IN ('loan_master', 'loan_masterhistory', 'suretymaster', 'guarrenter_mast')
    `);

        for (const row of moneyCols.rows) {
            console.log(`Converting ${row.table_name}.${row.column_name} from MONEY to NUMERIC...`);
            await client.query(`ALTER TABLE "${row.table_name}" ALTER COLUMN "${row.column_name}" TYPE numeric(19, 4) USING "${row.column_name}"::numeric`);
        }

        console.log('Migration completed successfully.');

    } catch (err) {
        console.error('Migration failed:', err);
    } finally {
        await client.end();
    }
}

migrate();
