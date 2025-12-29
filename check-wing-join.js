const { Client } = require('pg');

async function checkMemberWingValues() {
    const client = new Client({
        host: 'localhost',
        port: 5432,
        database: 'EMP_Espat_Society',
        user: 'postgres',
        password: 'Test@1212'
    });

    try {
        await client.connect();

        console.log('--- Checking MEMBER_MASTER Wing Values ---');
        const res = await client.query("SELECT DISTINCT wingno FROM member_master ORDER BY wingno LIMIT 10");
        console.table(res.rows);

        console.log('\n--- Checking JOIN Logic ---');
        const joinCheck = await client.query(`
            SELECT m.wingno AS member_wing, w.wingno AS master_wing, w.wname
            FROM member_master m
            LEFT JOIN wingmast w ON w.wingno = m.wingno
            WHERE m.wingno IS NOT NULL AND m.wingno != '' AND m.wingno != '0'
            LIMIT 5
        `);
        console.table(joinCheck.rows);

    } catch (err) {
        console.error(err);
    } finally {
        await client.end();
    }
}

checkMemberWingValues();
