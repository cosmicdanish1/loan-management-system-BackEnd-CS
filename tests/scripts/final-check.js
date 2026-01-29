const { Client } = require('pg');

async function finalCheck() {
    const client = new Client({
        user: 'postgres', host: 'localhost', database: 'EMP_Espat_Society', password: 'Test@1212', port: 5432,
    });
    try {
        await client.connect();
        const res = await client.query("SELECT code, head_name FROM headmaster WHERE code IN ('A1001', 'A1002', 'A1003', 'A1004', 'A1005', 'L2001', 'I3001', 'E4001', 'E4002')");
        console.table(res.rows);
    } catch (err) { console.error(err); } finally { await client.end(); }
}
finalCheck();
