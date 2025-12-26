const { Client } = require('pg');
const fs = require('fs');

async function checkAnnualStatementData() {
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
        // Find annual statement related tables
        log('=== Finding Annual Statement Tables ===');
        const annualTables = await client.query(`
      SELECT table_name 
      FROM information_schema.tables 
      WHERE table_schema = 'public' 
      AND table_name ILIKE '%annual%'
      ORDER BY table_name
    `);
        log('Annual statement tables: ' + JSON.stringify(annualTables.rows, null, 2));

        // Check annualstatement table if exists
        if (annualTables.rows.some(r => r.table_name === 'annualstatement')) {
            log('\n=== Annualstatement Table Structure ===');
            const cols = await client.query(`
        SELECT column_name, data_type, character_maximum_length 
        FROM information_schema.columns 
        WHERE table_name = 'annualstatement'
        ORDER BY ordinal_position
      `);
            log('Columns (' + cols.rows.length + '): ' + cols.rows.map(r => `${r.column_name} (${r.data_type})`).join(', '));

            // Count records
            const count = await client.query('SELECT COUNT(*) as count FROM annualstatement');
            log('\nTotal records: ' + count.rows[0].count);

            // Sample data
            log('\n=== Sample Annual Statement Data ===');
            const sample = await client.query('SELECT * FROM annualstatement LIMIT 3');
            log(JSON.stringify(sample.rows, null, 2));
        }

        // Check for division/branch tables
        log('\n=== Finding Division/Branch Tables ===');
        const divisionTables = await client.query(`
      SELECT table_name 
      FROM information_schema.tables 
      WHERE table_schema = 'public' 
      AND (table_name ILIKE '%division%' OR table_name ILIKE '%branch%' OR table_name ILIKE '%wing%' OR table_name ILIKE '%office%')
      ORDER BY table_name
    `);
        log('Division/Branch tables: ' + divisionTables.rows.map(r => r.table_name).join(', '));

        // Check wingmast table (wings might be divisions)
        log('\n=== Wing Master Table ===');
        const wingCount = await client.query('SELECT COUNT(*) as count FROM wingmast');
        log('Wing records: ' + wingCount.rows[0].count);

        const wings = await client.query('SELECT wingno, wname FROM wingmast ORDER BY wingno LIMIT 10');
        log('Sample wings:', JSON.stringify(wings.rows, null, 2));

        // Check officemaster table
        log('\n=== Office Master Table ===');
        const officeTables = await client.query(`
      SELECT table_name 
      FROM information_schema.tables 
      WHERE table_schema = 'public' 
      AND table_name ILIKE '%office%'
    `);
        log('Office tables: ' + officeTables.rows.map(r => r.table_name).join(', '));

        // Check member_master for divisions/branches
        log('\n=== Member Master Division/Branch Info ===');
        const mmDivisions = await client.query(`
      SELECT DISTINCT wingno 
      FROM member_master 
      WHERE wingno IS NOT NULL 
      ORDER BY wingno 
      LIMIT 10
    `);
        log('Sample wingno values: ' + mmDivisions.rows.map(r => r.wingno).join(', '));

        const mmOffices = await client.query(`
      SELECT DISTINCT officeno 
      FROM member_master 
      WHERE officeno IS NOT NULL 
      ORDER BY officeno 
      LIMIT 10
    `);
        log('Sample officeno values: ' + mmOffices.rows.map(r => r.officeno).join(', '));

        // Write to file
        fs.writeFileSync('annual-statement-check.txt', output.join('\n'));
        log('\n✅ Output saved to annual-statement-check.txt');

    } catch (error) {
        log('Error: ' + error.message);
        log(error.stack);
    } finally {
        await client.end();
    }
}

checkAnnualStatementData();
