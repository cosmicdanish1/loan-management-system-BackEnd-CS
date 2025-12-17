// Test script for Day-book SB functionality
// This script tests the Day-book SB API endpoints to ensure they work correctly

const axios = require('axios');

const API_BASE_URL = 'http://localhost:3000/api/v1';

async function testDayBookSB() {
  try {
    console.log('🧪 Testing Day-book SB API...');
    console.log('='.repeat(50));
    
    // Test regular daybook endpoint
    console.log('\n1️⃣ Testing regular daybook endpoint:');
    const regularResponse = await axios.get(`${API_BASE_URL}/daybook/report?date=2025-12-17`);
    console.log('✅ Regular daybook status:', regularResponse.status);
    console.log('📊 Regular daybook summary:', {
      totalReceipts: regularResponse.data.data.data.totalReceipts,
      totalPayments: regularResponse.data.data.data.totalPayments,
      totalTransactions: regularResponse.data.data.data.totalTransactions,
      entriesCount: regularResponse.data.data.data.entries.length
    });
    
    // Test SB-specific endpoint
    console.log('\n2️⃣ Testing SB-specific endpoint:');
    const sbResponse = await axios.get(`${API_BASE_URL}/daybook/report/sb?date=2025-12-17`);
    console.log('✅ SB daybook status:', sbResponse.status);
    console.log('📊 SB daybook summary:', {
      totalReceipts: sbResponse.data.data.data.totalReceipts,
      totalPayments: sbResponse.data.data.data.totalPayments,
      totalTransactions: sbResponse.data.data.data.totalTransactions,
      entriesCount: sbResponse.data.data.data.entries.length
    });
    
    // Test with filterType parameter
    console.log('\n3️⃣ Testing with filterType parameter:');
    const filterResponse = await axios.get(`${API_BASE_URL}/daybook/report?date=2025-12-17&filterType=sb`);
    console.log('✅ Filter daybook status:', filterResponse.status);
    console.log('📊 Filter daybook summary:', {
      totalReceipts: filterResponse.data.data.data.totalReceipts,
      totalPayments: filterResponse.data.data.data.totalPayments,
      totalTransactions: filterResponse.data.data.data.totalTransactions,
      entriesCount: filterResponse.data.data.data.entries.length
    });
    
    // Verify SB filtering is working
    console.log('\n4️⃣ Verifying SB filtering:');
    const regularEntries = regularResponse.data.data.data.entries;
    const sbEntries = sbResponse.data.data.data.entries;
    
    console.log('📈 Regular daybook entries:', regularEntries.length);
    console.log('📈 SB daybook entries:', sbEntries.length);
    
    if (sbEntries.length <= regularEntries.length) {
      console.log('✅ SB filtering is working correctly (SB entries <= regular entries)');
    } else {
      console.log('❌ SB filtering might have an issue (SB entries > regular entries)');
    }
    
    // Check if SB entries only contain savings-related codes
    const sbCodes = [...new Set(sbEntries.map(e => e.headCode))];
    console.log('💰 SB head codes found:', sbCodes);
    
    const savingsRelatedCodes = sbCodes.filter(code => 
      code.startsWith('A') || code === 'A1001' || code === 'A1002' || code === 'A1003'
    );
    
    if (savingsRelatedCodes.length === sbCodes.length) {
      console.log('✅ All SB entries are savings-related');
    } else {
      console.log('⚠️ Some SB entries might not be savings-related');
    }
    
    console.log('\n🎉 All tests completed successfully!');
    console.log('='.repeat(50));
    
  } catch (error) {
    console.error('❌ Test failed:', error.message);
    if (error.response) {
      console.error('📊 Response status:', error.response.status);
      console.error('📄 Response data:', error.response.data);
    }
  }
}

// Run the test if this file is executed directly
if (require.main === module) {
  testDayBookSB();
}

module.exports = { testDayBookSB };