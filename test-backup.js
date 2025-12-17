// Simple test script to verify backup functionality
const { exec } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

// Test configuration
const testConfig = {
  host: 'localhost',
  port: 5432,
  username: 'postgres',
  password: 'Test@1212',
  database: 'EMP_Espat_Society',
  testPath: './test-backup'
};

async function testBackup() {
  console.log('🧪 Testing PostgreSQL Backup Functionality...\n');
  console.log(`🖥️  Platform: ${os.platform()} ${os.arch()}`);
  console.log(`📁 Working Directory: ${process.cwd()}\n`);

  // 0. Check if PostgreSQL client tools are available
  console.log('0. Checking PostgreSQL client tools...');
  try {
    await new Promise((resolve, reject) => {
      exec('psql --version', { timeout: 5000 }, (error, stdout, stderr) => {
        if (error) {
          reject(error);
        } else {
          console.log('✅ psql available:', stdout.trim());
          resolve(stdout);
        }
      });
    });

    await new Promise((resolve, reject) => {
      exec('pg_dump --version', { timeout: 5000 }, (error, stdout, stderr) => {
        if (error) {
          reject(error);
        } else {
          console.log('✅ pg_dump available:', stdout.trim());
          resolve(stdout);
        }
      });
    });
  } catch (error) {
    console.log('❌ PostgreSQL client tools not found:', error.message);
    console.log('\n💡 Installation Instructions for Windows:');
    console.log('   1. Download PostgreSQL from: https://www.postgresql.org/download/windows/');
    console.log('   2. Run the installer and make sure to include "Command Line Tools"');
    console.log('   3. Add PostgreSQL bin directory to your PATH:');
    console.log('      - Default location: C:\\Program Files\\PostgreSQL\\15\\bin');
    console.log('      - Add to System Environment Variables > PATH');
    console.log('   4. Restart your command prompt/IDE');
    console.log('   5. Test with: psql --version');
    return;
  }

  // 1. Test PostgreSQL connection
  console.log('\n1. Testing database connection...');
  try {
    const testCommand = `psql --host=${testConfig.host} --port=${testConfig.port} --username=${testConfig.username} --dbname=${testConfig.database} --command="SELECT version();"`;
    
    await new Promise((resolve, reject) => {
      exec(testCommand, {
        env: { ...process.env, PGPASSWORD: testConfig.password },
        timeout: 10000
      }, (error, stdout, stderr) => {
        if (error) {
          reject(error);
        } else {
          console.log('✅ Database connection successful');
          resolve(stdout);
        }
      });
    });
  } catch (error) {
    console.log('❌ Database connection failed:', error.message);
    console.log('\n💡 Troubleshooting:');
    console.log('   - Make sure PostgreSQL server is running');
    console.log('   - Check if credentials are correct in backend/.env');
    console.log('   - Verify database exists: EMP_Espat_Society');
    console.log('   - Test manually: psql -h localhost -p 5432 -U postgres -d EMP_Espat_Society');
    return;
  }

  // 2. Test backup directory creation
  console.log('\n2. Testing backup directory...');
  try {
    if (!fs.existsSync(testConfig.testPath)) {
      fs.mkdirSync(testConfig.testPath, { recursive: true });
    }
    console.log('✅ Backup directory ready');
  } catch (error) {
    console.log('❌ Failed to create backup directory:', error.message);
    return;
  }

  // 3. Test pg_dump availability
  console.log('\n3. Testing pg_dump availability...');
  try {
    await new Promise((resolve, reject) => {
      exec('pg_dump --version', (error, stdout, stderr) => {
        if (error) {
          reject(error);
        } else {
          console.log('✅ pg_dump available:', stdout.trim());
          resolve(stdout);
        }
      });
    });
  } catch (error) {
    console.log('❌ pg_dump not found:', error.message);
    console.log('💡 Install PostgreSQL client tools and add to PATH');
    return;
  }

  // 4. Test actual backup creation
  console.log('\n4. Testing backup creation...');
  try {
    const timestamp = new Date().toISOString().slice(0, 19).replace(/[T:]/g, '_').replace(/-/g, '_');
    const backupFile = path.join(testConfig.testPath, `test_backup_${timestamp}.sql`);
    
    const backupCommand = [
      'pg_dump',
      `--host=${testConfig.host}`,
      `--port=${testConfig.port}`,
      `--username=${testConfig.username}`,
      '--verbose',
      '--clean',
      '--if-exists',
      `--file="${backupFile}"`,
      testConfig.database
    ].join(' ');

    await new Promise((resolve, reject) => {
      exec(backupCommand, {
        env: { ...process.env, PGPASSWORD: testConfig.password },
        timeout: 60000 // 1 minute timeout
      }, (error, stdout, stderr) => {
        if (error) {
          reject(error);
        } else {
          resolve({ stdout, stderr });
        }
      });
    });

    // Check if backup file was created
    if (fs.existsSync(backupFile)) {
      const stats = fs.statSync(backupFile);
      console.log(`✅ Backup created successfully: ${backupFile}`);
      console.log(`📁 File size: ${(stats.size / 1024 / 1024).toFixed(2)} MB`);
      
      // Clean up test file
      fs.unlinkSync(backupFile);
      console.log('🧹 Test backup file cleaned up');
    } else {
      console.log('❌ Backup file was not created');
    }

  } catch (error) {
    console.log('❌ Backup creation failed:', error.message);
    return;
  }

  // 5. Clean up test directory
  try {
    fs.rmdirSync(testConfig.testPath);
    console.log('🧹 Test directory cleaned up');
  } catch (error) {
    console.log('⚠️  Could not clean up test directory:', error.message);
  }

  console.log('\n🎉 All tests passed! Backup functionality is working correctly.');
  console.log('\n📋 Next steps:');
  console.log('   1. Start the backend server: npm run start:dev');
  console.log('   2. Open the frontend Database Backup utility');
  console.log('   3. Test the backup functionality through the UI');
}

// Run the test
testBackup().catch(error => {
  console.error('💥 Test failed:', error);
  process.exit(1);
});