const { Client } = require('pg');
require('dotenv').config();

async function inspectVoucher() {
    const connectionString = 'postgresql://postgres:Test@1212@localhost:5432/EMP_Espat_Society';
    const client = new Client({ connectionString });

    try {
        await client.connect();
        console.log('Inspecting voucher_staging:');
        const res = await client.query('SELECT * FROM voucher_staging');
        console.table(res.rows);

        if (res.rows.length > 0) {
            const vno = res.rows[0].voucher_no;
            console.log(`\nInspecting details for ${vno}:`);
            const resDetails = await client.query('SELECT * FROM voucher_staging_details WHERE voucher_no = $1', [vno]);
            console.table(resDetails.rows);
        }

    } catch (err) {
        console.error(err.message);
    } finally {
        await client.end();
    }
}

inspectVoucher();
