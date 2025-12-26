const { Client } = require('pg');

async function populateBalanceSheet() {
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

        const today = new Date().toISOString().split('T')[0];
        const fyStart = `${new Date().getFullYear()}-04-01`;

        // 1. Create Report Schedule if none exists
        const scheduleCount = await client.query("SELECT count(*) FROM report_schedule_header WHERE report_type = 'BS'");
        if (parseInt(scheduleCount.rows[0].count) === 0) {
            console.log('Creating sample Balance Sheet schedule...');

            const headerResult = await client.query(`
        INSERT INTO report_schedule_header (schedule_name, template_name, report_type)
        VALUES ($1, $2, $3)
        RETURNING id
      `, ['Sample Balance Sheet', 'Standard Template', 'BS']);

            const scheduleId = headerResult.rows[0].id;

            const details = [
                { particulars: 'Capital Fund', code_from: 'L1000', code_to: 'L1010' },
                { particulars: 'Reserve Fund', code_from: 'L1011', code_to: 'L1020' },
                { particulars: 'Member Deposits', code_from: 'L2000', code_to: 'L3000' },
                { particulars: 'Cash in Hand', code_from: 'A001', code_to: 'A005' },
                { particulars: 'Loans to Members', code_from: 'A1000', code_to: 'A2000' },
                { particulars: 'Investments', code_from: 'A3000', code_to: 'A4000' }
            ];

            for (const detail of details) {
                await client.query(`
          INSERT INTO report_schedule_details (schedule_id, particulars, code_from, code_to)
          VALUES ($1, $2, $3, $4)
        `, [scheduleId, detail.particulars, detail.code_from, detail.code_to]);
            }
            console.log('Schedule created with ID:', scheduleId);
        }

        // 2. Add sample ledger data for today to see in the report
        console.log('Adding sample ledger data for today...');
        const samples = [
            { code: 'L1001', mbno: 1, amt: 50000, type: 'CR', narr: 'Initial Capital' },
            { code: 'L2001', mbno: 2, amt: 25000, type: 'CR', narr: 'Deposit Received' },
            { code: 'A001', mbno: 0, amt: 75000, type: 'DR', narr: 'Cash Balance' },
            { code: 'A1001', mbno: 3, amt: 15000, type: 'DR', narr: 'Loan Issued' }
        ];

        for (const s of samples) {
            // Find max trans_no
            const maxRes = await client.query("SELECT COALESCE(MAX(CAST(trans_no AS numeric)), 0) as max_no FROM ledger");
            const nextNo = (parseInt(maxRes.rows[0].max_no) + 1).toString();

            // Find max ledgerid
            const maxLedgerRes = await client.query("SELECT COALESCE(MAX(ledgerid), 0) as max_id FROM ledger");
            const nextLedgerId = parseInt(maxLedgerRes.rows[0].max_id) + 1;

            await client.query(`
            INSERT INTO ledger (trans_no, trans_date, trans_type, code, mbno, acc_no, acc_type, trans_amt, narration, pl_balance, receipt_vchr_no, vchr_type, modeofpay, username, ledgerid)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 0, '', '', '', 'test', $10)
        `, [nextNo, today, s.type, s.code, s.mbno, 0, 'OTH', s.amt, s.narr, nextLedgerId]);
        }
        console.log('Ledger entries added');

        // 3. Final Verification
        const res = await client.query(`
      SELECT h.schedule_name, count(d.id) as detail_count
      FROM report_schedule_header h
      JOIN report_schedule_details d ON h.id = d.schedule_id
      WHERE h.report_type = 'BS'
      GROUP BY h.schedule_name
    `);
        console.log('Current Schedules:', res.rows);

    } catch (error) {
        console.error('Error:', error.message);
    } finally {
        await client.end();
    }
}

populateBalanceSheet();
