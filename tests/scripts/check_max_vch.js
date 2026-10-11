const { Client } = require('pg');
require('dotenv').config();

async function checkMax() {
    const connectionString = `postgresql://${process.env.DB_USERNAME || 'postgres'}:${encodeURIComponent(process.env.DB_PASSWORD || '')}@${process.env.DB_HOST || 'localhost'}:${process.env.DB_PORT || 5432}/${process.env.DB_DATABASE || 'EMP_Espat_Society'}`;
    const client = new Client({ connectionString });

    try {
        await client.connect();

        console.log('Max in voucher_staging:');
        const resVs = await client.query("SELECT MAX(voucher_no) FROM voucher_staging");
        console.table(resVs.rows);

        console.log('Max in vouchers:');
        const resV = await client.query("SELECT MAX(\"voucherNumber\") FROM vouchers");
        console.table(resV.rows);

    } catch (err) {
        console.error(err.message);
    } finally {
        await client.end();
    }
}

checkMax();
