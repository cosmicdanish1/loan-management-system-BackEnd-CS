const fetch = require('node-fetch');

async function testShareWarrantAPI() {
    const API_URL = 'http://localhost:3001/api/v1/report/share-warrant';

    const params = new URLSearchParams({
        memberFrom: '610000000',
        memberTo: '610999999',
        warrantDate: '2025-12-26'
    });

    try {
        console.log(`Testing API: ${API_URL}?${params.toString()}`);
        const res = await fetch(`${API_URL}?${params.toString()}`);
        const result = await res.json();

        if (res.ok) {
            console.log('✅ Success!');
            console.log('Count:', Array.isArray(result) ? result.length : result.data?.length || 0);

            if (Array.isArray(result) && result.length > 0) {
                console.log('\nFirst item:');
                console.log(JSON.stringify(result[0], null, 2));
            } else if (result.data && result.data.length > 0) {
                console.log('\nFirst item:');
                console.log(JSON.stringify(result.data[0], null, 2));
            } else {
                console.log('\n⚠️  No data found. This might be expected if no share balances in this range.');
            }
        } else {
            console.error('❌ Error Response:', result);
        }
    } catch (error) {
        console.error('❌ Test failed:', error.message);
    }
}

testShareWarrantAPI();
