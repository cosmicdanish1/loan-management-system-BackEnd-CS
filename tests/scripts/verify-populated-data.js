const { Client } = require('pg');

async function verifyPopulatedData() {
    console.log('--- VERIFYING POPULATED INTEREST DATA ---');

    const client = new Client({
        host: 'localhost',
        port: 5432,
        database: 'EMP_Espat_Society',
        user: 'postgres',
        password: 'Test@1212'
    });

    try {
        await client.connect();

        // Simulating the backend query logic
        const res = await client.query(`
            SELECT 
                m.mbno, 
                COALESCE(w.wname, m.wingno) as wing,
                a.cur_triftamt as cd_bal,
                a.cur_shareamt as share_bal
            FROM member_master m
            LEFT JOIN annualstatement a ON a.accno = m.mbno
            LEFT JOIN wingmast w ON w.wingno = m.wingno
            WHERE m.isactive = 'Y' 
            AND m.flg_retire = 'N'
            AND (a.cur_triftamt > 0 OR a.cur_tfintrec > 0 OR a.cur_shareamt > 0)
        `);

        console.log(`Total Visible Rows with Balances: ${res.rows.length}`);

        if (res.rows.length > 0) {
            console.log('Sample Data:');
            console.table(res.rows.slice(0, 5));

            // Extract Unique Wings (Frontend Logic Simulation)
            const wings = [...new Set(res.rows.map(r => r.wing).filter(Boolean))];
            console.log('Unique Wings found:', wings);
        }

    } catch (err) {
        console.error(err);
    } finally {
        await client.end();
    }
}

verifyPopulatedData();
