const { Client } = require('pg');
async function testJoin() {
    const client = new Client({ host: 'localhost', port: 5432, database: 'EMP_Espat_Society', user: 'postgres', password: 'Test@1212' });
    try {
        await client.connect();
        const res = await client.query(`
            SELECT m.mbno, m.officeno, o.office_name
            FROM member_master m
            LEFT JOIN office_master o ON o.officeno = m.officeno
            WHERE m.mbno = '610015819'
        `);
        console.log(res.rows);
    } catch (err) { console.error(err); } finally { await client.end(); }
}
testJoin();
