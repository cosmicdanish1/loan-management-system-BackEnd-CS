const { Client } = require('pg');
const client = new Client({ host: 'localhost', port: 5432, database: 'EMP_Espat_Society', user: 'postgres', password: 'Test@1212' });
(async () => {
    try {
        await client.connect();
        console.log('Connected.');
        const res = await client.query("SELECT code, head_name FROM headmaster WHERE head_name ILIKE '%LOAN%'");
        console.log('Loan Heads:', res.rows);
    } catch (e) { console.error(e); }
    finally { await client.end(); }
})();
