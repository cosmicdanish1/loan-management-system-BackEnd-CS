const { Client } = require('pg');

async function verifyBalanceSheetData() {
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

        // 1. Check Report Schedules
        const schedules = await client.query("SELECT * FROM report_schedule_header WHERE report_type = 'BS'");
        console.log(`Found ${schedules.rows.length} Balance Sheet schedules`);

        if (schedules.rows.length > 0) {
            const scheduleId = schedules.rows[0].id;
            const details = await client.query("SELECT * FROM report_schedule_details WHERE schedule_id = $1", [scheduleId]);
            console.log(`Schedule ID ${scheduleId} has ${details.rows.length} detail rows`);
        }

        // 2. Check Ledger Data
        const ledgerCount = await client.query("SELECT count(*) FROM ledger");
        console.log(`Total ledger entries: ${ledgerCount.rows[0].count}`);

        // 3. Check HeadMaster Data
        const headCount = await client.query("SELECT count(*) FROM headmaster");
        console.log(`Total headmaster entries: ${headCount.rows[0].count}`);

        // 4. Sample Ledger Data check
        const sampleLedger = await client.query("SELECT * FROM ledger LIMIT 5");
        if (sampleLedger.rows.length > 0) {
            console.log('Sample Ledger entry:', sampleLedger.rows[0]);
        }

        // 5. Check if we need to populate
        if (schedules.rows.length === 0) {
            console.log('No BS schedules found. We should create one.');
        }
        if (parseInt(ledgerCount.rows[0].count) === 0) {
            console.log('Ledger is empty. We should populate it.');
        }

    } catch (error) {
        console.error('Error:', error.message);
    } finally {
        await client.end();
    }
}

verifyBalanceSheetData();
