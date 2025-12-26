const { Client } = require('pg');

async function convertMoneyToNumeric() {
    const client = new Client({
        host: 'localhost',
        port: 5432,
        database: 'EMP_Espat_Society',
        user: 'postgres',
        password: 'Test@1212',
    });

    try {
        await client.connect();
        console.log('Connected to database');

        console.log('Converting ledger.trans_amt from MONEY to NUMERIC(19, 4)...');
        // We need to cast through text and remove any currency symbols/commas if they exist
        // Actually, casting MONEY to NUMERIC in PG can be tricky if the locale adds symbols.
        // The safest way is to cast to numeric directly if possible, or via text.

        await client.query('ALTER TABLE ledger ALTER COLUMN trans_amt TYPE numeric(19, 4) USING trans_amt::numeric');
        console.log('Converted trans_amt successfully');

        console.log('Converting ledger.pl_balance from MONEY to NUMERIC(19, 4)...');
        await client.query('ALTER TABLE ledger ALTER COLUMN pl_balance TYPE numeric(19, 4) USING pl_balance::numeric');
        console.log('Converted pl_balance successfully');

        // Also check other tables mentioned in schema that use money
        const otherTables = await client.query(`
      SELECT table_name, column_name 
      FROM information_schema.columns 
      WHERE data_type = 'money' 
      AND table_schema = 'public'
    `);

        for (const row of otherTables.rows) {
            console.log(`Converting ${row.table_name}.${row.column_name} from MONEY to NUMERIC(19, 4)...`);
            await client.query(`ALTER TABLE "${row.table_name}" ALTER COLUMN "${row.column_name}" TYPE numeric(19, 4) USING "${row.column_name}"::numeric`);
        }

        console.log('All conversions completed successfully');

    } catch (error) {
        console.error('Error during conversion:', error.message);
        if (error.message.includes('cannot be automatically cast')) {
            console.log('Note: Some locale-specific money types might need manual cleaning.');
        }
    } finally {
        await client.end();
    }
}

convertMoneyToNumeric();
