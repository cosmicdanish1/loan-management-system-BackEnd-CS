const { Client } = require('pg');

async function checkMemberMasterSchema() {
    const client = new Client({
        host: 'localhost', port: 5432, database: 'EMP_Espat_Society', user: 'postgres', password: 'Test@1212'
    });
    try {
        await client.connect();
        console.log('--- MEMBER_MASTER NUMERIC COLUMNS ---');
        const res = await client.query(`
            SELECT column_name, data_type 
            FROM information_schema.columns 
            WHERE table_name = 'member_master' 
            AND data_type IN ('numeric', 'decimal', 'money', 'real', 'double precision')
        `);
        console.table(res.rows);

        const res2 = await client.query(`
            SELECT column_name, data_type 
            FROM information_schema.columns 
            WHERE table_name = 'member_master' 
            AND (column_name LIKE '%pay%' OR column_name LIKE '%amt%' OR column_name LIKE '%salary%' OR column_name LIKE '%bal%')
        `);
        console.log('\n--- POTENTIAL MONEY COLUMNS IN MEMBER_MASTER ---');
        console.table(res2.rows);

        const res3 = await client.query(`SELECT basic_pay FROM member_master WHERE basic_pay IS NOT NULL LIMIT 5`);
        console.log('\n--- SAMPLE basic_pay DATA ---');
        console.table(res3.rows);

    } catch (err) { console.error(err); } finally { await client.end(); }
}
checkMemberMasterSchema();
