const { Client } = require('pg');

async function checkReceiptPaymentData() {
    const client = new Client({
        user: 'postgres',
        host: 'localhost',
        database: 'EMP_Espat_Society',
        password: 'Test@1212',
        port: 5432,
    });

    try {
        await client.connect();
        console.log('Connected to DB');

        // Check for existing vouchers
        const res = await client.query("SELECT * FROM transactions WHERE receipt_vchr_no != '' LIMIT 10");
        console.log(`Found ${res.rows.length} existing vouchers.`);
        if (res.rows.length > 0) {
            console.table(res.rows);
        } else {
            console.log('No vouchers found. Inserting sample data...');

            // Get max trans_no to avoid primary key collision
            const maxRes = await client.query("SELECT COALESCE(MAX(trans_no), 0) as max_no FROM transactions");
            const nextTransNo = parseInt(maxRes.rows[0].max_no) + 1;

            const insertQuery = `
                INSERT INTO transactions (
                    trans_no, trans_date, trans_type, mbno, acc_no, acc_type, trans_amt, 
                    receipt_vchr_no, vchr_type, modeofpay, narration, code
                ) VALUES (
                    $1, NOW(), 'DR', 12345, 1001, 'OTH', 5000.00, 
                    'RV-001', 'R', 'C', 'Test Payment Voucher', '101'
                ) RETURNING *;
            `;

            try {
                const insertRes = await client.query(insertQuery, [nextTransNo]);
                console.log('Inserted sample voucher:', insertRes.rows[0]);
            } catch (insertErr) {
                console.error('Error inserting sample data:', insertErr);
            }
        }

    } catch (err) {
        console.error('Error:', err);
    } finally {
        await client.end();
    }
}

checkReceiptPaymentData();
