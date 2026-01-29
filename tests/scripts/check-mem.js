const { Client } = require('pg');
async function checkMember() {
    const client = new Client({ host: 'localhost', port: 5432, database: 'EMP_Espat_Society', user: 'postgres', password: 'Test@1212' });
    try {
        await client.connect();
        const res = await client.query("SELECT mbno, officeno FROM member_master WHERE mbno = '610015819'");
        console.log(res.rows);
    } catch (err) { console.error(err); } finally { await client.end(); }
}
checkMember();
