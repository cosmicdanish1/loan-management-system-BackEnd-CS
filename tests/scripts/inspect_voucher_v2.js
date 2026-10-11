const { Client } = require('pg');
require('dotenv').config();

async function inspectVoucher() {
    const connectionString = `postgresql://${process.env.DB_USERNAME || 'postgres'}:${encodeURIComponent(process.env.DB_PASSWORD || '')}@${process.env.DB_HOST || 'localhost'}:${process.env.DB_PORT || 5432}/${process.env.DB_DATABASE || 'EMP_Espat_Society'}`;
    const client = new Client({ connectionString });

    try {
        await client.connect();
        const res = await client.query('SELECT * FROM voucher_staging');
        res.rows.forEach(r => {
            console.log(`Voucher: ${r.voucher_no}, Case: ${r.loan_case_no}, Amount: ${r.amount}, Posted: ${r.is_posted}, Status: ${r.status}`);
        });

    } catch (err) {
        console.error(err.message);
    } finally {
        await client.end();
    }
}

inspectVoucher();
