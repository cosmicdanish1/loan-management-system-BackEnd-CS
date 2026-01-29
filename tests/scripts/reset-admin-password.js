// Script to reset admin password with proper bcrypt hashing
const bcrypt = require('bcrypt');
const { Client } = require('pg');

async function resetAdminPassword() {
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

    // First, fix the password column length to support bcrypt
    console.log('\nFixing password column length...');
    try {
      await client.query('ALTER TABLE usermaster ALTER COLUMN spassword TYPE VARCHAR(255)');
      console.log('✓ Password column updated to VARCHAR(255)');
    } catch (error) {
      if (error.message.includes('already exists')) {
        console.log('✓ Password column already correct length');
      } else {
        console.log('Note: Column alter may have failed, but continuing...');
      }
    }

    // Generate bcrypt hash for 'admin123'
    const password = 'admin123';
    const saltRounds = 10;
    const hashedPassword = await bcrypt.hash(password, saltRounds);
    
    console.log('\nGenerated hash for password "admin123":');
    console.log(hashedPassword);

    // Update admin user
    const updateQuery = `
      UPDATE usermaster 
      SET spassword = $1,
          enable_disable = 'E',
          login_status = 'N'
      WHERE susername = 'admin'
      RETURNING userid, susername, enable_disable;
    `;

    const result = await client.query(updateQuery, [hashedPassword]);
    
    if (result.rows.length > 0) {
      console.log('\n✓ Admin password reset successfully!');
      console.log('User details:', result.rows[0]);
      console.log('\nYou can now login with:');
      console.log('Username: admin');
      console.log('Password: admin123');
    } else {
      console.log('\n✗ Admin user not found in database');
      console.log('Creating new admin user...');
      
      // Create admin user if not exists
      const insertQuery = `
        INSERT INTO usermaster (susername, spassword, userlevelid, enable_disable, login_status, date_of_creation)
        VALUES ('admin', $1, 1, 'E', 'N', NOW())
        RETURNING userid, susername, enable_disable;
      `;
      
      const insertResult = await client.query(insertQuery, [hashedPassword]);
      console.log('✓ Admin user created:', insertResult.rows[0]);
      console.log('\nYou can now login with:');
      console.log('Username: admin');
      console.log('Password: admin123');
    }

  } catch (error) {
    console.error('Error:', error.message);
    console.error('\nMake sure:');
    console.error('1. PostgreSQL is running');
    console.error('2. Database "emp" exists');
    console.error('3. User "postgres" with password "root" has access');
  } finally {
    await client.end();
  }
}

resetAdminPassword();
