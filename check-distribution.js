const { Client } = require('pg');

async function checkDistribution() {
    const client = new Client({
        host: 'localhost',
        port: 5432,
        database: 'EMP_Espat_Society',
        user: 'postgres',
        password: 'Test@1212'
    });

    try {
        await client.connect();

        console.log('--- Distribution of Wings for Eligible Members (Shares > 0) ---');
        const res = await client.query(`
            SELECT m.wingno, w.wname, COUNT(*) as count
            FROM member_master m
            LEFT JOIN annualstatement a ON a.accno = m.mbno
            LEFT JOIN wingmast w ON w.wingno = m.wingno
            WHERE m.isactive = 'Y' AND m.flg_retire = 'N' AND COALESCE(a.cur_shareamt, 0) > 0
            GROUP BY m.wingno, w.wname
        `);
        console.table(res.rows);

        console.log('\n--- Distribution of Offices for Eligible Members (Shares > 0) ---');
        const res2 = await client.query(`
            SELECT m.officeno, o.office_name, COUNT(*) as count
            FROM member_master m
            LEFT JOIN annualstatement a ON a.accno = m.mbno
            LEFT JOIN office_master o ON o.officeno = m.officeno
            WHERE m.isactive = 'Y' AND m.flg_retire = 'N' AND COALESCE(a.cur_shareamt, 0) > 0
            GROUP BY m.officeno, o.office_name
        `);
        console.table(res2.rows);

    } catch (err) {
        console.error(err);
    } finally {
        await client.end();
    }
}

checkDistribution();
