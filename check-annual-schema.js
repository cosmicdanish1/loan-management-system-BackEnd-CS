const { Client } = require('pg');

async function checkAnnualStatementSchema() {
    const client = new Client({
        host: 'localhost',
        port: 5432,
        database: 'EMP_Espat_Society',
        user: 'postgres',
        password: 'Test@1212'
    });

    try {
        await client.connect();

        console.log('--- ANNUALSTATEMENT TABLE COLUMNS ---');
        const res = await client.query(`
            SELECT column_name, data_type 
            FROM information_schema.columns 
            WHERE table_name = 'annualstatement'
        `);
        console.table(res.rows);

        console.log('\n--- SAMPLE DATA ---');
        const dataRes = await client.query(`
            SELECT accno, cur_triftamt, cur_tfintrec, cur_shareamt 
            FROM annualstatement 
            LIMIT 5
        `);
        console.table(dataRes.rows);

    } catch (err) {
        console.error(err);
    } finally {
        await client.end();
    }
}

checkAnnualStatementSchema();
