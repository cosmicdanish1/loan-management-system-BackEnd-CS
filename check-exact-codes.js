const { Client } = require('pg');

async function checkCodes() {
    const client = new Client({
        user: 'postgres', host: 'localhost', database: 'EMP_Espat_Society', password: 'Test@1212', port: 5432,
    });
    try {
        await client.connect();
        const codesToCheck = ['A1001', 'A1002', 'E4001', 'E4002', 'I3001'];

        console.log('Checking HeadMaster for codes:', codesToCheck);
        const res = await client.query("SELECT code, head_name FROM headmaster WHERE code = ANY($1)", [codesToCheck]);
        console.log('Results in HeadMaster:');
        res.rows.forEach(r => console.log(`'${r.code}' -> '${r.head_name}'`));

        console.log('\nChecking Transactions (raw codes):');
        const res2 = await client.query("SELECT DISTINCT code FROM transactions WHERE code = ANY($1)", [codesToCheck]);
        res2.rows.forEach(r => console.log(`Found in transactions: '${r.code}'`));

    } catch (err) { console.error(err); } finally { await client.end(); }
}
checkCodes();
