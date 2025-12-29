const { Client } = require('pg');
const client = new Client({ host: 'localhost', port: 5432, database: 'EMP_Espat_Society', user: 'postgres', password: 'Test@1212' });
(async () => {
    try {
        await client.connect();
        const res = await client.query("SELECT DISTINCT loantype FROM loan_master");
        console.log('Loan Master Types:', res.rows);
    } catch (e) { console.error(e); }
    finally { await client.end(); }
})();
