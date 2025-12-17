// Quick verification script for Day-book SB functionality
console.log('🔍 Verifying Day-book SB functionality...');

// Test the API endpoint directly
fetch('http://localhost:3000/api/v1/daybook/report/sb?date=2025-12-17')
  .then(response => response.json())
  .then(data => {
    console.log('✅ API Response received');
    console.log('📊 Response structure:', {
      success: data.success,
      hasData: !!data.data,
      hasNestedData: !!data.data?.data,
      hasActualData: !!data.data?.data?.data,
      entriesCount: data.data?.data?.data?.entries?.length || 0
    });
    
    if (data.data?.data?.data?.entries?.length > 0) {
      console.log('🎉 SUCCESS: Found', data.data.data.data.entries.length, 'SB transactions');
      console.log('💰 Sample transaction:', data.data.data.data.entries[0]);
    } else {
      console.log('⚠️ WARNING: No SB transactions found');
    }
    
    console.log('📈 Financial Summary:', {
      totalReceipts: data.data?.data?.data?.totalReceipts || 0,
      totalPayments: data.data?.data?.data?.totalPayments || 0,
      netBalance: data.data?.data?.data?.netBalance || 0,
      openingBalance: data.data?.data?.data?.openingBalance || 0,
      closingBalance: data.data?.data?.data?.closingBalance || 0
    });
  })
  .catch(error => {
    console.error('❌ API Error:', error);
  });