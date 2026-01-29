const { Client } = require('pg');

async function checkColumnTypes() {
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

        const res = await client.query(`
      SELECT column_name, data_type, udt_name
      FROM information_schema.columns 
      WHERE table_name = 'ledger' 
      AND column_name IN ('trans_amt', 'pl_balance')
    `);

        console.log('Column Types in Ledger table:');
        res.rows.forEach(row => {
            console.log(`- ${row.column_name}: ${row.data_type} (${row.udt_name})`);
        });

    } catch (error) {
        console.error('Error:', error.message);
    } finally {
        await client.end();
    }
}

checkColumnTypes();
