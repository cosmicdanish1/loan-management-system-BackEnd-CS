const { Client } = require('pg');
const fs = require('fs');

async function checkYearlyStatementData() {
    const client = new Client({
        host: 'localhost',
        port: 5432,
        database: 'EMP_Espat_Society',
        user: 'postgres',
        password: 'Test@1212'
    });

    const output = [];
    const log = (msg) => {
        console.log(msg);
        output.push(msg);
    };

    await client.connect();
    log('✅ Connected to database\n');

    try {
        // Check for yearly statement related tables
        log('=== Finding Yearly Statement Tables ===');
        const tables = await client.query(`
      SELECT table_name 
      FROM information_schema.tables 
      WHERE table_schema = 'public' 
      AND (table_name ILIKE '%yearly%' OR table_name ILIKE '%statement%' OR table_name ILIKE '%member%')
      ORDER BY table_name
    `);
        log('Relevant tables: ' + tables.rows.map(r => r.table_name).slice(0, 20).join(', '));

        // Check member_master for sample data
        log('\n=== Member Master Sample ===');
        const members = await client.query(`
      SELECT mbno, f_name, m_name, l_name, wingno, officeno, memb_date 
      FROM member_master 
      WHERE mbno IS NOT NULL 
      ORDER BY mbno 
      LIMIT 5
    `);
        log('Sample members: ' + JSON.stringify(members.rows, null, 2));

        // Check if there's any balance or transaction data
        log('\n=== Checking for member balances/transactions ===');
        const balCount = await client.query('SELECT COUNT(*) as count FROM member_balances');
        log('Member balances records: ' + balCount.rows[0].count);

        if (balCount.rows[0].count > 0) {
            const sampleBal = await client.query(`
        SELECT * FROM member_balances LIMIT 2
      `);
            log('Sample balance: ' + JSON.stringify(sampleBal.rows, null, 2));
        }

        // Check ledger table for transactions
        log('\n=== Checking ledger transactions ===');
        const ledgerCount = await client.query('SELECT COUNT(*) as count FROM ledger');
        log('Ledger records: ' + ledgerCount.rows[0].count);

        if (ledgerCount.rows[0].count > 0) {
            const sampleLedger = await client.query(`
        SELECT trans_date, mbno, code, trans_type, trans_amt, narration 
        FROM ledger 
        ORDER BY trans_date DESC 
        LIMIT 3
      `);
            log('Sample ledger entries: ' + JSON.stringify(sampleLedger.rows, null, 2));
        }

        // Get data type info for amounts
        log('\n=== Data Types Check ===');
        const balTypes = await client.query(`
      SELECT column_name, data_type 
      FROM information_schema.columns 
      WHERE table_name = 'member_balances' 
      AND column_name LIKE '%amt%' OR column_name LIKE '%balance%' OR column_name LIKE '%share%'
      ORDER BY column_name
    `);
        log('Amount columns in member_balances: ' + JSON.stringify(balTypes.rows, null, 2));

        // Write to file
        fs.writeFileSync('yearly-statement-check.txt', output.join('\n'));
        log('\n✅ Output saved to yearly-statement-check.txt');

    } catch (error) {
        log('Error: ' + error.message);
        log(error.stack);
    } finally {
        await client.end();
    }
}

checkYearlyStatementData();
