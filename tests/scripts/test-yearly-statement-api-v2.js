const fetch = require('node-fetch'); // Ensure node-fetch is available or use native fetch if node 18+

const API_URL = 'http://localhost:3001/api/v1/report/yearly-member-statement';

async function testApi() {
    const params = new URLSearchParams({
        fromDate: '2016-01-01',
        toDate: '2025-12-28',
        fromMemberNo: '610031566',
        toMemberNo: '610019978', // Inverted range
        wingNo: '1',
        officeNo: '1',
        sortBy: 'MBNO'
    });

    console.log(`Testing API: ${API_URL}?${params.toString()}`);

    try {
        const res = await fetch(`${API_URL}?${params.toString()}`);
        console.log(`Status: ${res.status} ${res.statusText}`);

        if (res.ok) {
            const result = await res.json();
            console.log("RAW JSON:", JSON.stringify(result, null, 2)); // DEBUG
            const data = result.data || result;
            const count = Array.isArray(data) ? data.length : 0;
            console.log(`Success! Count: ${count}`);
            console.log(`Is Fallback: ${result.isFallback}`);
        } else {
            const text = await res.text();
            console.log('Error Body:', text);
        }
    } catch (err) {
        console.error('Request failed:', err);
    }
}

testApi();
