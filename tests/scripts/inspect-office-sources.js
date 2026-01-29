const { Client } = require('pg');

async function inspectPotentialTables() {
    const client = new Client({
        host: 'localhost',
        port: 5432,
        database: 'EMP_Espat_Society',
        user: 'postgres',
        password: 'Test@1212'
    });

    try {
        await client.connect();

        console.log('--- CODES_TABLE ---');
        try {
            const res = await client.query("SELECT * FROM codes_table LIMIT 10");
            console.table(res.rows);
        } catch (e) { console.log('❌ codes_table error:', e.message); }

        console.log('\n--- DISTINCT OFFICE NUMBERS in MEMBER_MASTER ---');
        try {
            const res = await client.query("SELECT DISTINCT officeno FROM member_master ORDER BY officeno");
            console.log(res.rows.map(r => r.officeno));
        } catch (e) { console.log('❌ member_master error:', e.message); }

    } catch (err) {
        console.error(err);
    } finally {
        await client.end();
    }
}

inspectPotentialTables();
