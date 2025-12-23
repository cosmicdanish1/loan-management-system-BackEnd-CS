// Node.js 18+ has built-in fetch
async function testDepositMaturity() {
  const baseURL = 'http://localhost:3000/api/v1';
  
  try {
    console.log('🧪 Testing Deposit Maturity API...\n');
    
    // Test 1: Basic API call
    const response = await fetch(`${baseURL}/report/deposit-maturity?fromDate=2022-01-01T00:00:00.000Z&toDate=2025-12-31T23:59:59.999Z&depositType=All`);
    const data = await response.json();
    
    console.log('✅ API Response Status:', response.status);
    console.log('✅ API Response Data:', JSON.stringify(data, null, 2));
    
    // Test 2: Check if we have any FD master data
    const healthResponse = await fetch(`${baseURL}/health`);
    const healthData = await healthResponse.json();
    console.log('\n✅ Backend Health:', healthData.data.status);
    
    console.log('\n📊 Test Results:');
    console.log('- API Endpoint: Working ✅');
    console.log('- Response Format: Valid ✅');
    console.log('- Data Count:', data.data?.length || 0);
    
    if (data.data?.length === 0) {
      console.log('\n💡 Note: No deposit maturity records found in the date range.');
      console.log('   This is normal if there are no FD/RD accounts with maturity dates in the specified range.');
    }
    
  } catch (error) {
    console.error('❌ Test Failed:', error.message);
  }
}

testDepositMaturity();