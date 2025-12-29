const { Client } = require('pg');

async function verifyWarrantData() {
    console.log('--- VERIFYING DIVIDEND WARRANT DATA ---');

    const client = new Client({
        host: 'localhost',
        port: 5432,
        database: 'EMP_Espat_Society',
        user: 'postgres',
        password: 'Test@1212'
    });

    try {
        await client.connect();

        // Simulating the backend query logic but WITH NAMES
        const res = await client.query(`
            SELECT 
                m.mbno, 
                COALESCE(w.wname, m.wingno) as wing,
                COALESCE(o.office_name, CAST(m.officeno AS VARCHAR)) as office,
                a.cur_shareamt as share_amount
            FROM member_master m
            LEFT JOIN annualstatement a ON a.accno = m.mbno
            LEFT JOIN wingmast w ON w.wingno = m.wingno
            LEFT JOIN office_master o ON CAST(o.officeno AS VARCHAR) = CAST(m.officeno AS VARCHAR)
            WHERE m.isactive = 'Y' 
            AND m.flg_retire = 'N'
            AND a.cur_shareamt > 0
            LIMIT 10
        `);

        console.log(`Visible Warrants: ${res.rows.length}`);

        if (res.rows.length > 0) {
            console.log('Sample Data (with lookup names):');
            console.table(res.rows);
        } else {
            console.log('⚠️ No eligible members found for warrants (Need Active + Shares > 0)');
        }

    } catch (err) {
        console.error(err);
    } finally {
        await client.end();
    }
}

verifyWarrantData();
