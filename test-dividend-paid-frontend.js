const { Client } = require('pg');

async function testDividendPaidFrontend() {
    console.log('--- TESTING DIVIDEND PAID REPORT DATA [FRONTEND SIMULATION] ---');

    const client = new Client({
        host: 'localhost',
        port: 5432,
        database: 'EMP_Espat_Society',
        user: 'postgres',
        password: 'Test@1212'
    });

    try {
        await client.connect();

        // 1. Check Wing List (Frontend calls getDividendPaid with no filters to get all wings)
        console.log('\n🔍 Step 1: Fetching Wing List (for Dropdown)');
        const wingRes = await client.query(`
            SELECT DISTINCT COALESCE(w.wname, m.wingno) as wing
            FROM ledger l
            LEFT JOIN member_master m ON m.mbno = l.mbno
            LEFT JOIN wingmast w ON w.wingno = m.wingno
            WHERE l.trans_type = 'DR' 
            AND LOWER(l.narration) LIKE '%dividend%'
            ORDER BY wing
        `);
        console.log('Wings Available:', wingRes.rows.map(r => r.wing));

        // 2. Check Data Load (Frontend sends Date Range)
        const fromDate = '2024-04-01';
        const toDate = '2024-12-31';
        console.log(`\n🔍 Step 2: Fetching Report Data (${fromDate} to ${toDate})`);

        const dataRes = await client.query(`
            SELECT 
                l.trans_no as "transactionNo",
                l.trans_date as "paymentDate",
                l.mbno as "memberNo",
                CONCAT(m.prefix, ' ', m.f_name, ' ', COALESCE(m.m_name, ''), ' ', COALESCE(m.l_name, '')) as "memberName",
                COALESCE(w.wname, m.wingno) as wing,
                m.desig as designation,
                CAST(l.trans_amt AS numeric) as amount,
                l.receipt_vchr_no as "voucherNo"
            FROM ledger l
            LEFT JOIN member_master m ON m.mbno = l.mbno
            LEFT JOIN wingmast w ON w.wingno = m.wingno
            WHERE l.trans_type = 'DR' 
            AND LOWER(l.narration) LIKE '%dividend%'
            -- Note: In backend report.service.ts, there is no date filter yet! 
            -- Warning: Backend might be missing date filter logic if I didn't see it.
            -- I will check report.service.ts getDividendPaid for date filters.
        `);

        // Simulating the backend service filtering (which I need to verify exists)
        // If report.service.ts has filters, this simple SQL above is a baseline.

        const mappedData = dataRes.rows.map(row => ({
            ...row,
            amount: parseFloat(row.amount), // Check if it parses as number
            paymentDate: new Date(row.paymentDate).toISOString().split('T')[0]
        }));

        if (mappedData.length > 0) {
            console.log(`✅ Loaded ${mappedData.length} records.`);
            console.table(mappedData[0]); // Show first record structure

            // Check Data Types
            console.log('\n🔍 Step 3: Verifying Data Types');
            const sample = mappedData[0];
            console.log('Amount is number:', typeof sample.amount === 'number');
            console.log('Member Name is string:', typeof sample.memberName === 'string');
            console.log('Voucher No is string:', typeof sample.voucherNo === 'string');
        } else {
            console.log('⚠️ No records found! Check logic.');
        }

    } catch (err) {
        console.error(err);
    } finally {
        await client.end();
    }
}

testDividendPaidFrontend();
