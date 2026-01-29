const { Pool } = require('pg');
require('dotenv').config();

// Database configuration from environment
const pool = new Pool({
  user: process.env.DB_USER || 'postgres',
  host: process.env.DB_HOST || 'localhost',
  database: process.env.DB_NAME || 'EMP_Espat_Society',
  password: process.env.DB_PASSWORD || 'admin',
  port: process.env.DB_PORT || 5432,
});

// Colors for console output
const colors = {
  reset: '\x1b[0m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  cyan: '\x1b[36m',
  red: '\x1b[31m'
};

function log(message, color = 'reset') {
  console.log(`${colors[color]}${message}${colors.reset}`);
}

async function addMissingMembers() {
  log('👥 ADDING MISSING MEMBERS FOR DAYBOOK', 'cyan');
  
  try {
    // Get members referenced in transactions but missing from member_master
    const missingMembers = await pool.query(`
      SELECT DISTINCT t.mbno 
      FROM transactions t
      LEFT JOIN member_master m ON t.mbno::text = m.mbno::text
      WHERE t.mbno > 0 AND m.mbno IS NULL
      ORDER BY t.mbno
    `);
    
    log(`Found ${missingMembers.rows.length} missing members`, 'blue');
    
    if (missingMembers.rows.length === 0) {
      log('✓ All transaction members exist in member_master', 'green');
      
      // Show sample of existing members for the transaction member numbers
      const sampleCheck = await pool.query(`
        SELECT DISTINCT t.mbno, m.f_name, m.m_name, m.l_name
        FROM transactions t
        JOIN member_master m ON t.mbno::text = m.mbno::text
        WHERE t.mbno > 0
        ORDER BY t.mbno
        LIMIT 10
      `);
      
      log('\n👥 Sample transaction members found:', 'cyan');
      sampleCheck.rows.forEach((member, i) => {
        log(`  ${i + 1}. ${member.mbno} - ${member.f_name} ${member.m_name} ${member.l_name}`, 'green');
      });
      
      return true;
    }
    
    let successCount = 0;
    
    for (const row of missingMembers.rows) {
      const mbno = row.mbno;
      
      try {
        await pool.query(`
          INSERT INTO member_master (
            mbno, f_name, m_name, l_name, sex, present_address, 
            officeno, isactive, memb_date, pfno
          ) VALUES (
            $1, $2, $3, $4, 'M', $5, 
            1, 'Y', CURRENT_DATE, $6
          )
        `, [
          mbno,
          `Member${mbno}`,
          'Kumar',
          'Singh',
          `Address for Member ${mbno}, Nagpur`,
          `PF${mbno}`
        ]);
        
        log(`✓ Created member: ${mbno} - Member${mbno} Kumar Singh`, 'green');
        successCount++;
        
      } catch (error) {
        log(`✗ Failed to create member ${mbno}: ${error.message}`, 'red');
      }
    }
    
    log(`\n✅ Successfully created ${successCount} missing members`, 'green');
    
    // Verify the integration
    const verifyQuery = await pool.query(`
      SELECT 
        t.mbno,
        m.f_name,
        m.m_name,
        m.l_name,
        COUNT(t.*) as transaction_count
      FROM transactions t
      JOIN member_master m ON t.mbno::text = m.mbno::text
      WHERE t.mbno > 0
      GROUP BY t.mbno, m.f_name, m.m_name, m.l_name
      ORDER BY t.mbno
    `);
    
    log(`\n📊 Member-Transaction Integration:`, 'cyan');
    verifyQuery.rows.forEach((row, i) => {
      log(`  ${i + 1}. ${row.mbno} - ${row.f_name} ${row.m_name} ${row.l_name} (${row.transaction_count} transactions)`, 'blue');
    });
    
    return true;
    
  } catch (error) {
    log(`❌ Error: ${error.message}`, 'red');
    return false;
  } finally {
    await pool.end();
  }
}

// Run if called directly
if (require.main === module) {
  addMissingMembers()
    .then(success => {
      if (success) {
        console.log('\n🎉 Missing members added successfully!');
        console.log('DayBook should now show proper member names.');
        console.log('Run: node test-daybook-comprehensive.js to verify');
      }
      process.exit(success ? 0 : 1);
    })
    .catch(error => {
      console.error('Script failed:', error);
      process.exit(1);
    });
}

module.exports = { addMissingMembers };