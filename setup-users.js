/**
 * Setup Users with Encrypted Passwords
 * 
 * This script creates test users with bcrypt-encrypted passwords
 * Run with: node setup-users.js
 */

const bcrypt = require('bcrypt');
const { Client } = require('pg');
require('dotenv').config();

// Database configuration from .env
const dbConfig = {
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT) || 5432,
  user: process.env.DB_USERNAME || 'postgres',
  password: process.env.DB_PASSWORD,
  database: process.env.DB_DATABASE || 'employeesociety_new',
};

// Test users to create
const users = [
  {
    username: 'admin',
    password: 'admin123',
    userlevelid: 1,
    enable_disable: 'E',
    pass_transaction_flag: 'Y'
  },
  {
    username: 'manager',
    password: 'manager123',
    userlevelid: 2,
    enable_disable: 'E',
    pass_transaction_flag: 'Y'
  },
  {
    username: 'clerk',
    password: 'clerk123',
    userlevelid: 3,
    enable_disable: 'E',
    pass_transaction_flag: 'N'
  }
];

async function setupUsers() {
  const client = new Client(dbConfig);
  
  try {
    console.log('Connecting to database...');
    await client.connect();
    console.log('Connected successfully!\n');

    // Step 1: Ensure password column can hold bcrypt hash
    console.log('Step 1: Updating password column size...');
    await client.query(`
      ALTER TABLE usermaster 
      ALTER COLUMN spassword TYPE VARCHAR(255);
    `);
    console.log('✓ Password column updated\n');

    // Step 2: Insert user levels
    console.log('Step 2: Setting up user levels...');
    await client.query(`
      INSERT INTO userlevelmaster (userlevelid, userlevel) 
      VALUES 
        (1, 'Admin'),
        (2, 'Manager'),
        (3, 'Clerk')
      ON CONFLICT (userlevelid) DO NOTHING;
    `);
    console.log('✓ User levels created\n');

    // Step 3: Create users with encrypted passwords
    console.log('Step 3: Creating users with encrypted passwords...');
    
    for (const user of users) {
      console.log(`\nProcessing user: ${user.username}`);
      
      // Hash the password
      const hashedPassword = await bcrypt.hash(user.password, 10);
      console.log(`  Plain password: ${user.password}`);
      console.log(`  Hashed password: ${hashedPassword.substring(0, 20)}...`);
      
      // Delete existing user and related records
      const existingUser = await client.query(
        'SELECT userid FROM usermaster WHERE susername = $1',
        [user.username]
      );
      
      if (existingUser.rows.length > 0) {
        const userid = existingUser.rows[0].userid;
        console.log(`  Deleting existing user (ID: ${userid})...`);
        
        await client.query('DELETE FROM logintime WHERE userid = $1', [userid]);
        await client.query('DELETE FROM userinfo WHERE userid = $1', [userid]);
        await client.query('DELETE FROM userrights WHERE userid = $1', [userid]);
        await client.query('DELETE FROM usermaster WHERE userid = $1', [userid]);
      }
      
      // Insert new user
      const result = await client.query(`
        INSERT INTO usermaster (
          susername, 
          spassword, 
          userlevelid, 
          enable_disable, 
          date_of_creation, 
          login_status, 
          pass_transaction_flag
        ) 
        VALUES ($1, $2, $3, $4, CURRENT_TIMESTAMP, 'N', $5)
        RETURNING userid, susername
      `, [
        user.username,
        hashedPassword,
        user.userlevelid,
        user.enable_disable,
        user.pass_transaction_flag
      ]);
      
      console.log(`  ✓ User created with ID: ${result.rows[0].userid}`);
    }

    // Step 4: Verify users
    console.log('\n\nStep 4: Verifying created users...');
    console.log('═══════════════════════════════════════════════════════════');
    
    const verifyResult = await client.query(`
      SELECT 
        u.userid,
        u.susername as username,
        ul.userlevel as role,
        u.enable_disable as status,
        LENGTH(u.spassword) as password_length,
        CASE 
          WHEN LENGTH(u.spassword) > 50 THEN '✓ Encrypted'
          ELSE '✗ Plain text'
        END as password_status
      FROM usermaster u
      LEFT JOIN userlevelmaster ul ON u.userlevelid = ul.userlevelid
      WHERE u.susername IN ('admin', 'manager', 'clerk')
      ORDER BY u.userid;
    `);
    
    console.table(verifyResult.rows);
    
    console.log('\n✓ Setup complete!');
    console.log('\nYou can now login with:');
    console.log('  Username: admin    | Password: admin123');
    console.log('  Username: manager  | Password: manager123');
    console.log('  Username: clerk    | Password: clerk123');
    
  } catch (error) {
    console.error('\n✗ Error:', error.message);
    if (error.code) {
      console.error('Error code:', error.code);
    }
    process.exit(1);
  } finally {
    await client.end();
    console.log('\nDatabase connection closed.');
  }
}

// Run the setup
setupUsers();
