const { Client } = require('pg');

async function debug() {
    const client = new Client({
        user: 'postgres', host: 'localhost', database: 'EMP_Espat_Society', password: 'Test@1212', port: 5432,
    });
    try {
        await client.connect();
        console.log('--- HeadMaster Table ---');
        const res = await client.query("SELECT * FROM headmaster WHERE code IN ('A1001', 'A1002', 'L2001', 'I3001', 'E4001', 'E4002')");
        console.table(res.rows);

        console.log('\n--- Transactions for a sample date ---');
        const res2 = await client.query("SELECT DISTINCT code FROM transactions LIMIT 5");
        console.table(res2.rows);

    } catch (err) { console.error(err); } finally { await client.end(); }
}
debug();
