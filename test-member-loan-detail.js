const fetch = require('node-fetch');

async function testMemberLoanDetail() {
    const API_URL = 'http://localhost:3001/api/v1/report/member-loan-detail';

    const params = new URLSearchParams({
        memberFrom: '30000000',
        memberTo: '30100000',
        loanType: 'ALL'
    });

    try {
        console.log(`Testing API: ${API_URL}?${params.toString()}`);
        const res = await fetch(`${API_URL}?${params.toString()}`);
        const result = await res.json();

        if (res.ok) {
            console.log('Success!');
            console.log('Count:', result.length);
            if (result.length > 0) {
                console.log('First Item:', result[0]);
            } else {
                console.log('No data found. This might be expected if no loans in this range.');
            }
        } else {
            console.error('Error Response:', result);
        }
    } catch (error) {
        console.error('Test failed:', error.message);
    }
}

testMemberLoanDetail();
