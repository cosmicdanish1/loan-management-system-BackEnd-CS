const { Client } = require('pg');

async function check() {
    const client = new Client({
        host: 'localhost',
        port: 5432,
        database: 'EMP_Espat_Society',
        user: 'postgres',
        password: 'Test@1212',
    });

    try {
        await client.connect();

        console.log('--- loan_master ---');
        const lm = await client.query("SELECT column_name, data_type FROM information_schema.columns WHERE table_name = 'loan_master'");
        console.log(JSON.stringify(lm.rows.map(r => r.column_name)));

        console.log('\n--- loan_pending ---');
        const lp = await client.query("SELECT column_name, data_type FROM information_schema.columns WHERE table_name = 'loan_pending'");
        console.log(JSON.stringify(lp.rows.map(r => r.column_name)));

        console.log('\n--- Column Search (g1mbno/surety) ---');
        const colSearch = await client.query(`
        SELECT table_name, column_name 
        FROM information_schema.columns 
        WHERE table_schema = 'public' 
        AND (column_name LIKE '%g1mbno%' OR column_name LIKE '%surety%')
    `);
        console.dir(colSearch.rows, { maxArrayLength: null });

        console.log('\n--- Population Check ---');
        const lmCount = await client.query('SELECT count(*) FROM loan_master');
        const lpCount = await client.query('SELECT count(*) FROM loan_pending');
        console.log(`Master: ${lmCount.rows[0].count}, Pending: ${lpCount.rows[0].count}`);

        const sampleLM = await client.query('SELECT * FROM loan_master LIMIT 1');
        console.log('Sample LM:', sampleLM.rows[0]);

    } catch (error) {
        console.error(error);
    } finally {
        await client.end();
    }
}

check();
