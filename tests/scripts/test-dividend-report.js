const fetch = require('node-fetch');
const { Client } = require('pg');

async function testDividendReport() {
    const client = new Client({
        host: 'localhost',
        port: 5432,
        database: 'EMP_Espat_Society',
        user: 'postgres',
        password: 'Test@1212'
    });

    console.log('=== DIVIDEND REPORT TEST ===\n');

    try {
        await client.connect();
        console.log('✅ Database connected');

        // 1. Check Member Master and Annual Statement Join
        console.log('\n1️⃣  Checking Member Master and Annual Statement Join...');

        // Count active members
        const memberCount = await client.query("SELECT COUNT(*) FROM member_master WHERE isactive = 'Y' AND flg_retire = 'N'");
        console.log('Active Members:', memberCount.rows[0].count);

        // Check if annual statement has data for these members
        const joinCheck = await client.query(`
            SELECT COUNT(*) 
            FROM member_master m
            JOIN annualstatement a ON a.accno = m.mbno
            WHERE m.isactive = 'Y' AND m.flg_retire = 'N'
        `);
        console.log('Members with Annual Statement:', joinCheck.rows[0].count);

        if (parseInt(joinCheck.rows[0].count) < 2) {
            console.log('⚠️  Data Missing. Inserting dummy annual statement data...');

            // Check if we have member '1001' and '1002' which we used in previous tests, if not create basic members
            // Assuming members exist from previous tests or manual entry. If not, this might fail, but let's assume they might exist or we insert some basics.

            // Let's create proper test members if needed for Dividend
            await client.query(`
                INSERT INTO member_master (mbno, f_name, l_name, isactive, flg_retire, wingno, officeno, desig)
                VALUES 
                ('1005', 'Amit', 'Kumar', 'Y', 'N', 'W1', 1, 'Clerk')
                ON CONFLICT (mbno) DO UPDATE SET isactive = 'Y', flg_retire = 'N';

                INSERT INTO member_master (mbno, f_name, l_name, isactive, flg_retire, wingno, officeno, desig)
                VALUES 
                ('1006', 'Sumit', 'Singh', 'Y', 'N', 'W2', 2, 'Manager')
                ON CONFLICT (mbno) DO UPDATE SET isactive = 'Y', flg_retire = 'N';
             `);

            // Now insert annual statement data
            await client.query(`
                INSERT INTO annualstatement (accno, cur_shareamt, opn_shareamt, trans_date)
                VALUES 
                ('1005', 50000.00, 45000.00, '2024-03-31'),
                ('1006', 75000.00, 70000.00, '2024-03-31')
                ON CONFLICT (accno) DO UPDATE SET cur_shareamt = EXCLUDED.cur_shareamt;
             `);

            console.log('✅ Inserted dummy member and statement data');
        }

        // 2. Test Backend API Logic directly via SQL (simulate Service logic)
        console.log('\n2️⃣  Simulating Service Logic (dividend calculation)...');
        const dividendRate = 10;
        const testQuery = await client.query(`
            SELECT 
                m.mbno as memberNo,
                CONCAT(m.prefix, ' ', m.f_name, ' ', COALESCE(m.m_name, ''), ' ', COALESCE(m.l_name, '')) as memberName,
                m.wingno as wing,
                CAST(m.officeno AS VARCHAR) as office,
                COALESCE(a.cur_shareamt, 0) as shareAmount,
                ROUND((COALESCE(a.cur_shareamt, 0) * ${dividendRate}) / 100, 2) as dividendAmount
            FROM member_master m
            LEFT JOIN annualstatement a ON a.accno = m.mbno
            WHERE m.isactive = 'Y' AND m.flg_retire = 'N'
            LIMIT 5
        `);
        console.log('Sample Data:', testQuery.rows);

        // 3. Test API Endpoint
        console.log('\n3️⃣  Testing Backend API...');
        const url = `http://localhost:3001/api/v1/report/dividend?financialYear=2024-2025&dividendRate=12`; // Testing with 12%

        console.log('Requesting:', url);
        const response = await fetch(url);
        const result = await response.json();

        if (result.success) {
            console.log('✅ API Success!');
            console.log(`Received ${result.data.data.length} records`);
            console.log('Summary:', result.data.summary);

            if (result.data.data.length > 0) {
                const firstRec = result.data.data[0];
                const expectedDiv = (firstRec.shareAmount * 12) / 100;
                if (Math.abs(firstRec.dividendAmount - expectedDiv) < 0.1) {
                    console.log('✅ Dividend calculation verified (within 0.1 margin)');
                } else {
                    console.warn(`⚠️ Dividend calculation mismatch: Share ${firstRec.shareAmount} @ 12% should be ${expectedDiv}, got ${firstRec.dividendAmount}`);
                }
            }

        } else {
            console.error('❌ API Failed:', result);
        }

    } catch (error) {
        console.error('❌ Test Error:', error);
    } finally {
        await client.end();
    }
}

testDividendReport();
