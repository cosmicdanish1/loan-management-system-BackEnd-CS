const { Client } = require('pg');

async function verifyInterestWingNames() {
    console.log('--- VERIFYING INTEREST LIST WING NAMES ---');

    const client = new Client({
        host: 'localhost',
        port: 5432,
        database: 'EMP_Espat_Society',
        user: 'postgres',
        password: 'Test@1212'
    });

    try {
        await client.connect();

        console.log('\n🔍 Fetching Wings with Name Resolution (Simulating API)');
        const wingRes = await client.query(`
            SELECT DISTINCT COALESCE(w.wname, m.wingno) as wing
            FROM member_master m
            LEFT JOIN wingmast w ON w.wingno = m.wingno
            WHERE m.isactive = 'Y' AND m.flg_retire = 'N'
            ORDER BY wing
        `);
        console.log('Wings Available:', wingRes.rows.map(r => r.wing));

        // Also check if office names populate
        console.log('\n🔍 Checking Data Sample for Names');
        const dataRes = await client.query(`
            SELECT 
                m.mbno,
                COALESCE(w.wname, m.wingno) as wing,
                COALESCE(o.office_name, CAST(m.officeno AS VARCHAR)) as office
            FROM member_master m
            LEFT JOIN wingmast w ON w.wingno = m.wingno
            LEFT JOIN office_master o ON CAST(o.officeno AS VARCHAR) = CAST(m.officeno AS VARCHAR)
            WHERE m.isactive = 'Y' AND m.flg_retire = 'N'
            LIMIT 5
        `);
        console.table(dataRes.rows);

    } catch (err) {
        console.error(err);
    } finally {
        await client.end();
    }
}

verifyInterestWingNames();
