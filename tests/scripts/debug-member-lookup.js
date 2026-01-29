/**
 * Debug Script: Member Lookup Issues
 * 
 * This script investigates the member lookup problems:
 * 1. Only 50 members showing
 * 2. Duplicate entries appearing
 */

const { Client } = require('pg');
require('dotenv').config();

async function debugMemberLookup() {
  const client = new Client({
    host: process.env.DB_HOST || 'localhost',
    port: parseInt(process.env.DB_PORT) || 5432,
    user: process.env.DB_USERNAME || 'postgres',
    password: process.env.DB_PASSWORD || 'password',
    database: process.env.DB_DATABASE || 'loan_management'
  });

  try {
    await client.connect();
    console.log('🔗 Connected to database');

    // 1. Check total active members
    console.log('\n📊 TOTAL ACTIVE MEMBERS:');
    const totalQuery = `
      SELECT COUNT(*) as total_count
      FROM member_master m
      WHERE m.isactive = 'Y'
    `;
    const totalResult = await client.query(totalQuery);
    console.log(`Total active members: ${totalResult.rows[0].total_count}`);

    // 2. Check for duplicates in member_master
    console.log('\n🔍 CHECKING FOR DUPLICATES IN MEMBER_MASTER:');
    const duplicateQuery = `
      SELECT mbno, COUNT(*) as count
      FROM member_master
      WHERE isactive = 'Y'
      GROUP BY mbno
      HAVING COUNT(*) > 1
      ORDER BY count DESC
      LIMIT 10
    `;
    const duplicateResult = await client.query(duplicateQuery);
    if (duplicateResult.rows.length > 0) {
      console.log('❌ Found duplicate member numbers:');
      duplicateResult.rows.forEach(row => {
        console.log(`  Member ${row.mbno}: ${row.count} records`);
      });
    } else {
      console.log('✅ No duplicate member numbers found');
    }

    // 3. Test current lookup query (first 10 results)
    console.log('\n🧪 TESTING CURRENT LOOKUP QUERY (first 10):');
    const currentQuery = `
      SELECT 
        m.mbno as memberNo,
        TRIM(COALESCE(m.f_name, '') || ' ' || COALESCE(m.m_name, '') || ' ' || COALESCE(m.l_name, '')) as memberName,
        m.officeno as officeNo,
        m.wingno as wingNo,
        COALESCE(d.name, 'Unknown Office') as officeName
      FROM member_master m
      LEFT JOIN division_master d ON m.officeno = d.officeno AND m.wingno = d.wingno
      WHERE m.isactive = 'Y'
      ORDER BY TRIM(COALESCE(m.f_name, '') || ' ' || COALESCE(m.m_name, '') || ' ' || COALESCE(m.l_name, ''))
      LIMIT 10
    `;
    const currentResult = await client.query(currentQuery);
    console.log('Current query results:');
    currentResult.rows.forEach((row, index) => {
      console.log(`  ${index + 1}. ${row.memberno} - ${row.membername} (${row.officename})`);
    });

    // 4. Test improved query with DISTINCT
    console.log('\n✨ TESTING IMPROVED QUERY WITH DISTINCT (first 10):');
    const improvedQuery = `
      SELECT DISTINCT
        m.mbno as memberNo,
        TRIM(COALESCE(m.f_name, '') || ' ' || COALESCE(m.m_name, '') || ' ' || COALESCE(m.l_name, '')) as memberName,
        m.officeno as officeNo,
        m.wingno as wingNo,
        COALESCE(d.name, 'Unknown Office') as officeName
      FROM member_master m
      LEFT JOIN division_master d ON m.officeno = d.officeno AND m.wingno = d.wingno
      WHERE m.isactive = 'Y'
      ORDER BY TRIM(COALESCE(m.f_name, '') || ' ' || COALESCE(m.m_name, '') || ' ' || COALESCE(m.l_name, ''))
      LIMIT 10
    `;
    const improvedResult = await client.query(improvedQuery);
    console.log('Improved query results:');
    improvedResult.rows.forEach((row, index) => {
      console.log(`  ${index + 1}. ${row.memberno} - ${row.membername} (${row.officename})`);
    });

    // 5. Count total unique members
    console.log('\n📈 TOTAL UNIQUE ACTIVE MEMBERS:');
    const uniqueQuery = `
      SELECT COUNT(DISTINCT m.mbno) as unique_count
      FROM member_master m
      WHERE m.isactive = 'Y'
    `;
    const uniqueResult = await client.query(uniqueQuery);
    console.log(`Total unique active members: ${uniqueResult.rows[0].unique_count}`);

  } catch (error) {
    console.error('❌ Error:', error);
  } finally {
    await client.end();
    console.log('\n🔌 Database connection closed');
  }
}

// Run the debug
debugMemberLookup().catch(console.error);