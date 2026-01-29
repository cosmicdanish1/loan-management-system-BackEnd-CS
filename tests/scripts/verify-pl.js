const { Client } = require('pg');

async function checkPL() {
    const client = new Client({
        host: 'localhost',
        port: 5432,
        database: 'EMP_Espat_Society',
        user: 'postgres',
        password: 'Test@1212',
    });

    try {
        await client.connect();
        console.log('Connected to database');

        // 1. Check schemas for money types again (thoroughly)
        const moneyCols = await client.query(`
      SELECT table_name, column_name 
      FROM information_schema.columns 
      WHERE data_type = 'money' 
      AND table_schema = 'public'
    `);

        if (moneyCols.rows.length > 0) {
            console.log(`Found ${moneyCols.rows.length} columns with MONEY type. Converting...`);
            for (const row of moneyCols.rows) {
                console.log(`Converting ${row.table_name}.${row.column_name}...`);
                try {
                    await client.query(`ALTER TABLE "${row.table_name}" ALTER COLUMN "${row.column_name}" TYPE numeric(19, 4) USING "${row.column_name}"::numeric`);
                } catch (e) {
                    console.error(`Failed to convert ${row.table_name}.${row.column_name}: ${e.message}`);
                }
            }
        } else {
            console.log('No MONEY columns found.');
        }

        // 2. Check for P&L schedules
        const res = await client.query("SELECT * FROM report_schedule_header WHERE report_type = 'PL'");
        console.log('Existing P&L Schedules:', res.rows);

        if (res.rows.length === 0) {
            console.log('Populating sample P&L schedule...');
            const headerResult = await client.query(`
        INSERT INTO report_schedule_header (schedule_name, template_name, report_type)
        VALUES ($1, $2, $3)
        RETURNING id
      `, ['Sample Profit & Loss', 'Standard P&L', 'PL']);

            const scheduleId = headerResult.rows[0].id;

            const details = [
                { particulars: 'Interest on Loans', code_from: 'I1000', code_to: 'I1050' },
                { particulars: 'Processing Fees', code_from: 'I2000', code_to: 'I2050' },
                { particulars: 'Salary & Allowances', code_from: 'E1000', code_to: 'E1050' },
                { particulars: 'Rent, Rates & Taxes', code_from: 'E2000', code_to: 'E2050' },
                { particulars: 'Stationery & Printing', code_from: 'E3000', code_to: 'E3050' }
            ];

            for (const d of details) {
                await client.query(`
          INSERT INTO report_schedule_details (schedule_id, particulars, code_from, code_to)
          VALUES ($1, $2, $3, $4)
        `, [scheduleId, d.particulars, d.code_from, d.code_to]);
            }
            console.log('Sample P&L schedule created with ID:', scheduleId);
        }

        // 3. Add sample ledger data for P&L for today
        console.log('Adding sample P&L ledger data...');
        const today = new Date().toISOString().split('T')[0];
        const samples = [
            { code: 'I1001', mbno: 0, amt: 25000, type: 'CR', narr: 'Interest received' },
            { code: 'E1001', mbno: 0, amt: 12000, type: 'DR', narr: 'Staff Salary' },
            { code: 'E3001', mbno: 0, amt: 1500, type: 'DR', narr: 'Printing charges' }
        ];

        for (const s of samples) {
            const maxRes = await client.query("SELECT COALESCE(MAX(CAST(trans_no AS numeric)), 0) as max_no FROM ledger");
            const nextNo = (parseInt(maxRes.rows[0].max_no) + 1).toString();

            const maxLedgerRes = await client.query("SELECT COALESCE(MAX(ledgerid), 0) as max_id FROM ledger");
            const nextLedgerId = parseInt(maxLedgerRes.rows[0].max_id) + 1;

            await client.query(`
        INSERT INTO ledger (trans_no, trans_date, trans_type, code, mbno, acc_no, acc_type, trans_amt, narration, pl_balance, receipt_vchr_no, vchr_type, modeofpay, username, ledgerid)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 0, '', '', '', 'admin', $10)
      `, [nextNo, today, s.type, s.code, s.mbno, 0, 'OTH', s.amt, s.narr, nextLedgerId]);
        }
        console.log('P&L Ledger entries added.');

    } catch (error) {
        console.error('Error:', error.message);
    } finally {
        await client.end();
    }
}

checkPL();
