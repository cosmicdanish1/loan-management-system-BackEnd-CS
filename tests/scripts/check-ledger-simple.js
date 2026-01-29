const { Client } = require('pg');

async function checkLedgerTypeSimple() {
    const client = new Client({
        host: 'localhost',
        port: 5432,
        database: 'EMP_Espat_Society',
        user: 'postgres',
        password: 'Test@1212'
    });

    try {
        await client.connect();

        const res = await client.query(`
            SELECT column_name, data_type 
            FROM information_schema.columns 
            WHERE table_name = 'ledger' AND column_name = 'trans_amt'
        `);
        console.log('trans_amt type:', res.rows[0]);

        console.log('\n--- Running Verification of Data ---');
        // Re-run the verify logic here
        const query = `
            SELECT 
                l.trans_no, l.trans_date, l.mbno, l.trans_amt, l.narration
            FROM ledger l
            WHERE l.trans_type = 'DR' 
            AND LOWER(l.narration) LIKE '%dividend%'
            LIMIT 5
        `;
        const data = await client.query(query);
        console.log('Data Found:', data.rows);

    } catch (err) {
        console.error(err);
    } finally {
        await client.end();
    }
}

checkLedgerTypeSimple();
