const fetch = require('node-fetch');
const { Client } = require('pg');

async function testFinancialSummary() {
    const client = new Client({
        host: 'localhost',
        port: 5432,
        database: 'EMP_Espat_Society',
        user: 'postgres',
        password: 'Test@1212'
    });

    console.log('=== FINANCIAL SUMMARY REPORT TEST ===\n');

    try {
        await client.connect();
        console.log('✅ Database connected');

        // 1. Check Head Master for Head Types
        console.log('\n1️⃣  Checking HeadMaster Head Types...');
        const heads = await client.query(`
            SELECT headtype, COUNT(*) as count 
            FROM headmaster 
            WHERE headtype IN ('INC', 'EXP', 'AST', 'LIA')
            GROUP BY headtype
        `);
        console.log('Head Types found:', heads.rows);

        if (heads.rows.length === 0) {
            console.warn('⚠️  No valid head types (INC, EXP, AST, LIA) found in headmaster!');
        }

        // 2. Check Ledger Data
        console.log('\n2️⃣  Checking Ledger Data...');
        const ledgerCount = await client.query('SELECT COUNT(*) FROM ledger');
        console.log('Total Ledger Rows:', ledgerCount.rows[0].count);

        if (parseInt(ledgerCount.rows[0].count) === 0) {
            console.log('⚠️  No ledger data found. Inserting dummy data...');

            // Ensure we have some heads first
            await client.query(`
                INSERT INTO headmaster (code, head_name, headtype) VALUES 
                ('I001', 'Interest Income', 'INC') ON CONFLICT DO NOTHING;
                INSERT INTO headmaster (code, head_name, headtype) VALUES 
                ('E001', 'Office Expense', 'EXP') ON CONFLICT DO NOTHING;
                INSERT INTO headmaster (code, head_name, headtype) VALUES 
                ('A001', 'Cash in Hand', 'AST') ON CONFLICT DO NOTHING;
                INSERT INTO headmaster (code, head_name, headtype) VALUES 
                ('L001', 'Member Savings', 'LIA') ON CONFLICT DO NOTHING;
             `);

            // Insert transactions
            await client.query(`
                INSERT INTO ledger (trans_date, code, trans_type, trans_amt, narration, trans_no) VALUES
                ('2024-04-10', 'I001', 'CR', 5000, 'Interest Recvd', 101),
                ('2024-05-10', 'E001', 'DR', 2000, 'Bill Paid', 102),
                ('2024-06-10', 'A001', 'DR', 10000, 'Cash Deposit', 103),
                ('2024-07-10', 'L001', 'CR', 5000, 'Savings Deposit', 104)
             `);
            console.log('✅ Inserted dummy ledger data');
        }

        // 3. Test API
        console.log('\n3️⃣  Testing Backend API...');
        const fromDate = '2024-04-01';
        const toDate = '2024-12-31';
        const url = `http://localhost:3001/api/v1/report/financial-summary?fromDate=${fromDate}&toDate=${toDate}&includeOpBal=true&hideZeroClosing=false&hideZeroTrans=false`;

        console.log('Requesting:', url);
        const response = await fetch(url);
        const result = await response.json();

        if (result.success) {
            console.log('✅ API Success!');
            console.log(`Received ${result.data.length} records`);
            if (result.data.length > 0) {
                console.log('Sample Record:', result.data[0]);

                // Verify calculation
                const sample = result.data.find(d => d.periodDebit > 0 || d.periodCredit > 0);
                if (sample) {
                    console.log('Found active record:', sample);
                }
            } else {
                console.warn('⚠️  API returned 0 records despite having data in DB');
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

testFinancialSummary();
