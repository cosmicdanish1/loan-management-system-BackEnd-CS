const { Client } = require('pg');

const client = new Client({
  host: 'localhost',
  port: 5432,
  database: 'EMP_Espat_Society',
  user: 'postgres',
  password: 'Test@1212'
});

async function checkFDData() {
  try {
    await client.connect();
    console.log('Connected to database');
    
    // Check existing FD data
    const fdResult = await client.query("SELECT COUNT(*) as count FROM fdmaster WHERE fdrdflag = 'F'");
    console.log('Existing FD records:', fdResult.rows[0].count);
    
    // Check if member 9999962331 has any FD
    const memberFDResult = await client.query('SELECT * FROM fdmaster WHERE mbno = $1 AND fdrdflag = $2', [9999962331, 'F']);
    console.log('FD records for member 9999962331:', memberFDResult.rows.length);
    
    // Show some existing FD members
    const existingFDs = await client.query("SELECT mbno, certno, fdamount, depdate, matdate FROM fdmaster WHERE fdrdflag = 'F' LIMIT 5");
    console.log('Sample existing FD records:');
    existingFDs.rows.forEach(row => {
      console.log(`Member: ${row.mbno}, Cert: ${row.certno}, Amount: ${row.fdamount}, Date: ${row.depdate}`);
    });
    
    // Check what members exist in member_master
    const memberCount = await client.query("SELECT COUNT(*) as count FROM member_master");
    console.log('Total members in database:', memberCount.rows[0].count);
    
    // Show some sample members
    const sampleMembers = await client.query("SELECT mbno, f_name, l_name FROM member_master LIMIT 5");
    console.log('Sample members:');
    sampleMembers.rows.forEach(row => {
      console.log(`Member: ${row.mbno}, Name: ${row.f_name} ${row.l_name}`);
    });
    
    // Check if there are any members with FDs
    if (existingFDs.rows.length > 0) {
      console.log('\n✅ Found existing FD data. You can test with these member numbers.');
    } else {
      console.log('\n❌ No FD data found in database. The member lookup works but FD Certificate will show "No Fixed Deposit found" error.');
      console.log('This is expected behavior when a member has no FD accounts.');
    }
    
  } catch (error) {
    console.error('Error:', error.message);
  } finally {
    await client.end();
  }
}

checkFDData();