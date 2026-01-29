const { Client } = require('pg');

async function checkLedger() {
    const client = new Client({
        host: 'localhost',
        port: 5432,
        database: 'EMP_Espat_Society',
        user: 'postgres',
        password: 'Test@1212'
    });

    await client.connect();
    console.log('✅ Connected\n');

    try {
        // Count
        const count = await client.query('SELECT COUNT(*) as count FROM ledger');
        console.log('Ledger records:', count.rows[0].count);

        // Sample
        const sample = await client.query(`
      SELECT trans_date, mbno, trans_type, code, trans_amt, narration 
      FROM ledger 
      WHERE mbno IS NOT NULL AND mbno != '0'
      LIMIT 3
    `);
        console.log('\nSample:');
        console.log(JSON.stringify(sample.rows, null, 2));

        // Members with transactions
        const members = await client.query(`
      SELECT mbno, COUNT(*) as count 
      FROM ledger 
      WHERE mbno IS NOT NULL AND mbno != '0'
      GROUP BY mbno 
      LIMIT 3
    `);
        console.log('\nMembers with transactions:');
        console.log(JSON.stringify(members.rows, null, 2));

    } catch (error) {
        console.error('Error:', error.message);
    } finally {
        await client.end();
    }
}

checkLedger();
