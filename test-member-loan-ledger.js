const fetch = require('node-fetch');
const { Client } = require('pg');

async function testMemberLoanLedger() {
    const client = new Client({
        host: 'localhost',
        port: 5432,
        database: 'EMP_Espat_Society',
        user: 'postgres',
        password: 'Test@1212'
    });

    console.log('=== MEMBER LOAN LEDGER TEST ===\n');

    try {
        await client.connect();
        console.log('✅ Database connected\n');

        // 1. Check Head Codes
        console.log('1️⃣  Checking Loan Head Codes...');
        const heads = await client.query(`
            SELECT code, head_name FROM headmaster 
            WHERE code IN ('A1002', 'A1047')
        `);

        const foundCodes = heads.rows.map(h => h.code);
        console.log('Found Heads:', heads.rows);

        if (!foundCodes.includes('A1002')) console.warn('⚠️  Head A1002 (Regular Loan) NOT FOUND in headmaster');
        if (!foundCodes.includes('A1047')) console.warn('⚠️  Head A1047 (Short Term Loan) NOT FOUND in headmaster');

        // 2. Check Data Type of trans_amt
        console.log('\n2️⃣  Checking trans_amt data type...');
        const typeCheck = await client.query(`
            SELECT data_type FROM information_schema.columns 
            WHERE table_name = 'ledger' AND column_name = 'trans_amt'
        `);
        console.log('trans_amt type:', typeCheck.rows[0].data_type);

        if (typeCheck.rows[0].data_type !== 'numeric') {
            console.log('⚠️  Converting trans_amt to NUMERIC...');
            // We need to clean comma values first if it was varchar
            await client.query(`
                ALTER TABLE ledger 
                ALTER COLUMN trans_amt TYPE NUMERIC USING (REPLACE(REPLACE(trans_amt::text, ',', ''), '₹', '')::numeric)
             `);
            console.log('✅ Converted trans_amt to NUMERIC');
        }

        // 3. Find a member with Loan transactions
        console.log('\n3️⃣  Finding member with Loan transactions (A1002/A1047)...');
        const loanTrans = await client.query(`
            SELECT mbno, code, COUNT(*) as count 
            FROM ledger 
            WHERE code IN ('A1002', 'A1047') 
            GROUP BY mbno, code 
            LIMIT 5
        `);

        let memberCode = '';
        let headCode = '';

        if (loanTrans.rows.length > 0) {
            console.log('✅ Found existing loan transactions:', loanTrans.rows);
            memberCode = loanTrans.rows[0].mbno;
            headCode = loanTrans.rows[0].code;
        } else {
            console.log('⚠️  No loan transactions found. Creating dummy data...');
            memberCode = '1001'; // Default test member
            headCode = 'A1002';

            // Insert dummy transactions
            const insertQuery = `
                INSERT INTO ledger (trans_date, mbno, code, trans_type, trans_amt, narration, receipt_vchr_no, trans_no)
                VALUES 
                ('2024-01-15', $1, $2, 'DR', 50000, 'Loan Disbursement', 'V001', 1),
                ('2024-02-15', $1, $2, 'CR', 5000, 'Repayment Inst 1', 'R001', 2),
                ('2024-03-15', $1, $2, 'CR', 5000, 'Repayment Inst 2', 'R002', 3)
            `;
            await client.query(insertQuery, [memberCode, headCode]);
            console.log(`✅ Inserted 3 test transactions for member ${memberCode} head ${headCode}`);
        }

        // 4. Test API
        console.log('\n4️⃣  Testing Backend API...');
        const loanCategory = headCode === 'A1002' ? 'REGULAR' : 'SHORT_TERM';
        const asOnDate = '2025-12-31';

        const apiUrl = `http://localhost:3001/api/v1/report/member-loan-ledger?memberCode=${memberCode}&asOnDate=${asOnDate}&loanCategory=${loanCategory}`;
        console.log('Requesting:', apiUrl);

        const response = await fetch(apiUrl);
        const result = await response.json();

        if (response.ok && result.success) {
            console.log('✅ API Success!');
            console.log('Member Name:', result.data.memberName);
            console.log('Outstanding Balance:', result.data.outstandingBalance);
            console.log('Transaction Count:', result.data.transactions.length);
            if (result.data.transactions.length > 0) {
                console.log('Sample Trans:', result.data.transactions[0]);
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

testMemberLoanLedger();
