const { Client } = require('pg');

async function checkCounts() {
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
            SELECT 
                (SELECT COUNT(*) FROM member_master WHERE isactive='Y' AND flg_retire='N') as active_members,
                (SELECT COUNT(*) FROM annualstatement) as total_annual_records,
                (SELECT COUNT(*) 
                 FROM member_master m
                 JOIN annualstatement a ON a.accno = m.mbno
                 WHERE m.isactive='Y' AND m.flg_retire='N') as linked_active_records
        `);

        console.table(res.rows);

    } catch (err) {
        console.error(err);
    } finally {
        await client.end();
    }
}

checkCounts();
