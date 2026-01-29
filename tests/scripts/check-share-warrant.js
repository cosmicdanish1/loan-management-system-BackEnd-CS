const { Client } = require('pg');
const fs = require('fs');

async function checkShareWarrantData() {
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
    log('Connected to database\n');

    try {
        // Find tables with 'share' in name or columns
        log('=== Finding Share-related tables ===');
        const shareTables = await client.query(`
      SELECT DISTINCT table_name 
      FROM information_schema.columns 
      WHERE table_schema = 'public' 
      AND (column_name ILIKE '%share%' OR table_name ILIKE '%share%')
      ORDER BY table_name
    `);
        log('Tables with share columns: ' + JSON.stringify(shareTables.rows, null, 2));

        // Check columns with 'share' in name
        log('\n=== Share columns ===');
        const shareCols = await client.query(`
      SELECT table_name, column_name, data_type 
      FROM information_schema.columns 
      WHERE column_name ILIKE '%share%' 
      AND table_schema = 'public'
      ORDER BY table_name
    `);
        log('Share columns: ' + JSON.stringify(shareCols.rows, null, 2));

        // Check member_master columns
        log('\n=== Member Master table columns ===');
        const mmCols = await client.query(`
      SELECT column_name, data_type 
      FROM information_schema.columns 
      WHERE table_name = 'member_master' 
      AND table_schema = 'public'
      ORDER BY ordinal_position
    `);
        log('Member master columns (' + mmCols.rows.length + '): ' + mmCols.rows.map(r => r.column_name).join(', '));

        // Check for share-related data in member_master
        log('\n=== Checking member_master for share data ===');
        const shareData = await client.query(`
      SELECT mbno, f_name, m_name, l_name 
      FROM member_master 
      WHERE mbno IS NOT NULL
      LIMIT 5
    `);
        log('Sample members: ' + JSON.stringify(shareData.rows, null, 2));

        // Write to file
        fs.writeFileSync('share-warrant-check.txt', output.join('\n'));
        log('\n✅ Output saved to share-warrant-check.txt');

    } catch (error) {
        log('Error: ' + error.message);
    } finally {
        await client.end();
    }
}

checkShareWarrantData();
