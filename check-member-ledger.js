const { Client } = require('pg');
const fs = require('fs');

async function checkMemberLedgerData() {
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
        // Check ledger table
        log('=== Ledger Table Info ===');
        const ledgerCols = await client.query(`
      SELECT column_name, data_type 
      FROM information_schema.columns 
      WHERE table_name = 'ledger'
      ORDER BY ordinal_position
    `);
        log('Ledger columns: ' + ledgerCols.rows.map(r => `${r.column_name} (${r.data_type})`).join(', '));

        // Count total ledger records
        const ledgerCount = await client.query('SELECT COUNT(*) as count FROM ledger');
        log('\nTotal ledger records: ' + ledgerCount.rows[0].count);

        // Get sample ledger data for a specific member
        log('\n=== Sample Ledger Data ===');
        const sampleLedger = await client.query(`
      SELECT * FROM ledger 
      WHERE mbno IS NOT NULL 
      AND mbno != '0'
      ORDER BY trans_date DESC, trans_time DESC 
      LIMIT 5
    `);
        log('Sample ledger entries:');
        log(JSON.stringify(sampleLedger.rows, null, 2));

        // Check data types for monetary columns
        log('\n=== Data Type Check ===');
        const amtType = await client.query(`
      SELECT data_type, numeric_precision, numeric_scale 
      FROM information_schema.columns 
      WHERE table_name = 'ledger' AND column_name = 'trans_amt'
    `);
        log('trans_amt data type: ' + JSON.stringify(amtType.rows[0], null, 2));

        // Get member numbers that have ledger entries
        log('\n=== Members with Ledger Entries ===');
        const membersWithLedger = await client.query(`
      SELECT DISTINCT mbno, COUNT(*) as trans_count 
      FROM ledger 
      WHERE mbno IS NOT NULL AND mbno != '0'
      GROUP BY mbno 
      ORDER BY trans_count DESC 
      LIMIT 5
    `);
        log('Top members by transaction count:');
        log(JSON.stringify(membersWithLedger.rows, null, 2));

        // Get a member's transactions for testing
        if (membersWithLedger.rows.length > 0) {
            const testMember = membersWithLedger.rows[0].mbno;
            log(`\n=== Transactions for Member ${testMember} ===`);
            const memberTrans = await client.query(`
        SELECT trans_date, trans_type, code, trans_amt, narration, vchr_no
        FROM ledger 
        WHERE mbno = $1 
        ORDER BY trans_date DESC, trans_time DESC 
        LIMIT 10
      `, [testMember]);
            log(JSON.stringify(memberTrans.rows, null, 2));
        }

        // Write to file
        fs.writeFileSync('member-ledger-check.txt', output.join('\n'));
        log('\n✅ Output saved to member-ledger-check.txt');

    } catch (error) {
        log('Error: ' + error.message);
        log(error.stack);
    } finally {
        await client.end();
    }
}

checkMemberLedgerData();
