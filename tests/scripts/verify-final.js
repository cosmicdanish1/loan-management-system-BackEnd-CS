const { Client } = require('pg');
async function verifyFinal() {
    const client = new Client({ host: 'localhost', port: 5432, database: 'EMP_Espat_Society', user: 'postgres', password: 'Test@1212' });
    try {
        await client.connect();
        const res = await client.query(`
            SELECT 
                m.mbno, 
                COALESCE(w.wname, m.wingno) as wing,
                COALESCE(o.office_name, CAST(m.officeno AS VARCHAR)) as office
            FROM member_master m
            LEFT JOIN wingmast w ON w.wingno = m.wingno
            LEFT JOIN office_master o ON o.officeno = m.officeno
            JOIN annualstatement a ON a.accno = m.mbno
            WHERE m.isactive = 'Y' AND m.flg_retire = 'N' AND a.cur_shareamt > 0
            LIMIT 5
        `);
        console.table(res.rows);
    } catch (err) { console.error(err); } finally { await client.end(); }
}
verifyFinal();
