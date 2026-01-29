// Verification script to check if backup module is properly loaded
const axios = require('axios');

const API_BASE = 'http://localhost:3000/api/v1';

async function verifyBackupModule() {
  console.log('🔍 Verifying Backup Module Registration...\n');

  // Test endpoints
  const endpoints = [
    { method: 'GET', path: '/backup/test-connection', description: 'Test database connection' },
    { method: 'GET', path: '/backup/database-info', description: 'Get database info' },
    { method: 'GET', path: '/backup/list', description: 'List backups' },
    { method: 'POST', path: '/backup/validate-destination', description: 'Validate destination' },
  ];

  console.log('Testing backup endpoints...\n');

  for (const endpoint of endpoints) {
    try {
      const url = `${API_BASE}${endpoint.path}`;
      console.log(`Testing ${endpoint.method} ${endpoint.path}...`);

      let response;
      if (endpoint.method === 'GET') {
        response = await axios.get(url, { timeout: 5000 });
      } else {
        response = await axios.post(url, { destinationPath: 'C:\\temp' }, { timeout: 5000 });
      }

      console.log(`✅ ${endpoint.description}: ${response.status} ${response.statusText}`);
    } catch (error) {
      if (error.response) {
        if (error.response.status === 404) {
          console.log(`❌ ${endpoint.description}: 404 - Endpoint not found (module not loaded)`);
        } else if (error.response.status === 401) {
          console.log(`⚠️  ${endpoint.description}: 401 - Authentication required (endpoint exists)`);
        } else {
          console.log(`⚠️  ${endpoint.description}: ${error.response.status} - ${error.response.statusText}`);
        }
      } else if (error.code === 'ECONNREFUSED') {
        console.log(`❌ Cannot connect to backend server at ${API_BASE}`);
        console.log('💡 Make sure the backend server is running: npm run start:dev');
        break;
      } else {
        console.log(`❌ ${endpoint.description}: ${error.message}`);
      }
    }
  }

  console.log('\n📋 Troubleshooting Steps:');
  console.log('1. Restart the backend server: npm run start:dev');
  console.log('2. Check for compilation errors in the terminal');
  console.log('3. Verify BackupModule is imported in app.module.ts');
  console.log('4. Check if PostgreSQL is running and accessible');
}

// Run verification
verifyBackupModule().catch(error => {
  console.error('💥 Verification failed:', error.message);
});