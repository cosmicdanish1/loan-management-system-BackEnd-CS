const { Client } = require('pg');
require('dotenv').config();

async function checkFinalQuery() {
    const connectionString = 'postgresql://postgres:Test@1212@localhost:5432/EMP_Espat_Society';
    const client = new Client({ connectionString });

    try {
        await client.connect();

        const query = `
      SELECT 
        vs.voucher_no,
        lp.loantype,
        lp.loancaseno,
        mm.mbno,
        mm.f_name
      FROM voucher_staging vs
      JOIN loan_pending lp ON vs.loan_case_no = lp.loancaseno::text
      JOIN member_master mm ON lp.mbno = mm.mbno
      WHERE vs.status = 'PENDING' AND vs.is_posted = FALSE
    `;

        console.log('Running final JOIN query...');
        const res = await client.query(query);
        console.log(`Results found: ${res.rows.length}`);
        console.table(res.rows);

        if (res.rows.length === 0) {
            console.log('No rows. Checking individual JOIN steps:');
            const resStep1 = await client.query("SELECT vs.voucher_no FROM voucher_staging vs JOIN loan_pending lp ON vs.loan_case_no = lp.loancaseno::text");
            console.log(`Step 1 (vs JOIN lp): ${resStep1.rows.length} rows`);

            const resStep2 = await client.query("SELECT lp.loancaseno FROM loan_pending lp JOIN member_master mm ON lp.mbno = mm.mbno");
            console.log(`Step 2 (lp JOIN mm): ${resStep2.rows.length} rows`);
        }

    } catch (err) {
        console.error(err.message);
    } finally {
        await client.end();
    }
}

checkFinalQuery();
