const { Client } = require('pg');

async function verify() {
    const client = new Client({
        user: 'postgres', host: 'localhost', database: 'EMP_Espat_Society', password: 'Test@1212', port: 5432,
    });
    try {
        await client.connect();
        const res = await client.query('SELECT code, head_name FROM headmaster ORDER BY code');
        console.table(res.rows);
    } catch (err) { console.error(err); } finally { await client.end(); }
}
verify();
