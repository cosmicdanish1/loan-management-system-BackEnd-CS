const { Client } = require('pg');
require('dotenv').config();

async function checkMatch() {
    const connectionString = 'postgresql://postgres:Test@1212@localhost:5432/EMP_Espat_Society';
    const client = new Client({ connectionString });

    try {
        await client.connect();

        console.log('Querying loan_pending for loancaseno:');
        const resLp = await client.query("SELECT loancaseno, mbno, loantype FROM loan_pending WHERE loancaseno::text = '17897'");
        console.table(resLp.rows);

        console.log('\nTesting JOIN query:');
        const query = `
      SELECT vs.voucher_no, vs.loan_case_no, lp.loancaseno
      FROM voucher_staging vs
      JOIN loan_pending lp ON vs.loan_case_no = lp.loancaseno::text
    `;
        const resJoin = await client.query(query);
        console.table(resJoin.rows);

    } catch (err) {
        console.error(err.message);
    } finally {
        await client.end();
    }
}

checkMatch();
