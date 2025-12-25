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

async function populateMemberData() {
  log('👥 POPULATING MEMBER MASTER DATA', 'cyan');
  
  try {
    // Check existing members
    const existingMembers = await pool.query('SELECT COUNT(*) as count FROM member_master');
    const memberCount = parseInt(existingMembers.rows[0].count);
    
    log(`Found ${memberCount} existing members in database`, 'blue');
    
    if (memberCount === 0) {
      log('No members found. Creating sample member data...', 'yellow');
      
      // Sample member data
      const members = [
        {
          mbno: '1001',
          f_name: 'Rajesh',
          m_name: 'Kumar',
          l_name: 'Sharma',
          address: '123 Main Street, Nagpur',
          phone: '9876543210',
          email: 'rajesh.sharma@email.com',
          isactive: 'Y'
        },
        {
          mbno: '1002',
          f_name: 'Priya',
          m_name: 'Devi',
          l_name: 'Patel',
          address: '456 Park Road, Nagpur',
          phone: '9876543211',
          email: 'priya.patel@email.com',
          isactive: 'Y'
        },
        {
          mbno: '1003',
          f_name: 'Amit',
          m_name: 'Singh',
          l_name: 'Verma',
          address: '789 Garden Lane, Nagpur',
          phone: '9876543212',
          email: 'amit.verma@email.com',
          isactive: 'Y'
        },
        {
          mbno: '1004',
          f_name: 'Sunita',
          m_name: 'Rani',
          l_name: 'Gupta',
          address: '321 Hill View, Nagpur',
          phone: '9876543213',
          email: 'sunita.gupta@email.com',
          isactive: 'Y'
        },
        {
          mbno: '1005',
          f_name: 'Vikash',
          m_name: 'Chandra',
          l_name: 'Joshi',
          address: '654 River Side, Nagpur',
          phone: '9876543214',
          email: 'vikash.joshi@email.com',
          isactive: 'Y'
        },
        {
          mbno: '1006',
          f_name: 'Meera',
          m_name: 'Kumari',
          l_name: 'Singh',
          address: '987 Market Square, Nagpur',
          phone: '9876543215',
          email: 'meera.singh@email.com',
          isactive: 'Y'
        }
      ];
      
      let successCount = 0;
      
      for (const member of members) {
        try {
          await pool.query(`
            INSERT INTO member_master (
              mbno, f_name, m_name, l_name, address, phone, email, isactive,
              dob, gender, occupation, nominee_name, relation, 
              admission_date, admission_fee, share_amount
            ) VALUES (
              $1, $2, $3, $4, $5, $6, $7, $8,
              '1990-01-01', 'M', 'Service', 'Family Member', 'Spouse',
              CURRENT_DATE, 100.00, 1000.00
            )
          `, [
            member.mbno,
            member.f_name,
            member.m_name,
            member.l_name,
            member.address,
            member.phone,
            member.email,
            member.isactive
          ]);
          
          log(`✓ Created member: ${member.mbno} - ${member.f_name} ${member.m_name} ${member.l_name}`, 'green');
          successCount++;
          
        } catch (error) {
          log(`✗ Failed to create member ${member.mbno}: ${error.message}`, 'red');
        }
      }
      
      log(`\n✅ Successfully created ${successCount} members`, 'green');
      
    } else {
      log('Members already exist. Checking if transaction members exist...', 'blue');
      
      // Check if members referenced in transactions exist
      const transactionMembers = await pool.query(`
        SELECT DISTINCT mbno 
        FROM transactions 
        WHERE mbno > 0 
        ORDER BY mbno
      `);
      
      log(`Found ${transactionMembers.rows.length} unique member numbers in transactions`, 'blue');
      
      for (const row of transactionMembers.rows) {
        const mbno = row.mbno;
        
        // Check if this member exists in member_master
        const memberExists = await pool.query(`
          SELECT mbno, f_name, m_name, l_name 
          FROM member_master 
          WHERE mbno = $1
        `, [mbno.toString()]);
        
        if (memberExists.rows.length === 0) {
          log(`⚠ Member ${mbno} referenced in transactions but not in member_master`, 'yellow');
          
          // Create a default member record
          try {
            await pool.query(`
              INSERT INTO member_master (
                mbno, f_name, m_name, l_name, address, phone, email, isactive,
                dob, gender, occupation, nominee_name, relation, 
                admission_date, admission_fee, share_amount
              ) VALUES (
                $1, $2, $3, $4, $5, $6, $7, 'Y',
                '1990-01-01', 'M', 'Service', 'Family Member', 'Spouse',
                CURRENT_DATE, 100.00, 1000.00
              )
            `, [
              mbno.toString(),
              `Member${mbno}`,
              'Kumar',
              'Singh',
              `Address for Member ${mbno}, Nagpur`,
              `987654${mbno.toString().padStart(4, '0')}`,
              `member${mbno}@email.com`
            ]);
            
            log(`✓ Created missing member: ${mbno} - Member${mbno} Kumar Singh`, 'green');
            
          } catch (error) {
            log(`✗ Failed to create member ${mbno}: ${error.message}`, 'red');
          }
        } else {
          const member = memberExists.rows[0];
          log(`✓ Member ${mbno} exists: ${member.f_name} ${member.m_name} ${member.l_name}`, 'green');
        }
      }
    }
    
    // Verify the final state
    const finalCount = await pool.query('SELECT COUNT(*) as count FROM member_master WHERE isactive = $1', ['Y']);
    log(`\n📊 Final member count: ${finalCount.rows[0].count} active members`, 'cyan');
    
    // Show sample of members
    const sampleMembers = await pool.query(`
      SELECT mbno, f_name, m_name, l_name 
      FROM member_master 
      WHERE isactive = 'Y' 
      ORDER BY mbno 
      LIMIT 10
    `);
    
    log('\n👥 Sample members:', 'cyan');
    sampleMembers.rows.forEach((member, i) => {
      log(`  ${i + 1}. ${member.mbno} - ${member.f_name} ${member.m_name} ${member.l_name}`, 'blue');
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
  populateMemberData()
    .then(success => {
      if (success) {
        console.log('\n🎉 Member data populated successfully!');
        console.log('Run: node test-daybook-comprehensive.js to test with member names');
      }
      process.exit(success ? 0 : 1);
    })
    .catch(error => {
      console.error('Script failed:', error);
      process.exit(1);
    });
}

module.exports = { populateMemberData };