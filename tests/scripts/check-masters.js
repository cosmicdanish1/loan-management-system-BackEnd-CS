const { Client } = require('pg');

async function checkWingOffice() {
    const client = new Client({
        host: 'localhost',
        port: 5432,
        database: 'EMP_Espat_Society',
        user: 'postgres',
        password: 'Test@1212'
    });

    try {
        await client.connect();

        console.log('--- WING MASTER ---');
        try {
            const w = await client.query("SELECT * FROM wing_master LIMIT 5");
            console.table(w.rows);
        } catch (e) { console.log('❌ No wing_master table found'); }

        console.log('\n--- OFFICE MASTER ---');
        try {
            const o = await client.query("SELECT * FROM office_master LIMIT 5");
            console.table(o.rows);
        } catch (e) { console.log('❌ No office_master table found'); }

        console.log('\n--- MEMBER MASTER SAMPLE ---');
        try {
            const m = await client.query("SELECT mbno, wingno, officeno FROM member_master LIMIT 5");
            console.table(m.rows);
        } catch (e) { console.log('❌ No member_master table found'); }

    } catch (err) {
        console.error(err);
    } finally {
        await client.end();
    }
}

checkWingOffice();
