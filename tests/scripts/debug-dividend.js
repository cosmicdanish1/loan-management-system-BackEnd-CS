const fetch = require('node-fetch');
const { Client } = require('pg');

async function debugDividend() {
    const client = new Client({
        host: 'localhost',
        port: 5432,
        database: 'EMP_Espat_Society',
        user: 'postgres',
        password: 'Test@1212'
    });

    try {
        await client.connect();

        // 1. Check DB Data Magnitude
        console.log('🔍 Checking DB Data Magnitude...');
        const res = await client.query('SELECT MIN(cur_shareamt), MAX(cur_shareamt), AVG(cur_shareamt) FROM annualstatement');
        console.table(res.rows);

        // 2. Call API
        console.log('\n🔍 Calling API...');
        // CORRECTED URL
        const url = `http://localhost:3001/api/v1/report/dividend-report?financialYear=2024-2025&dividendRate=10`;

        const response = await fetch(url);
        if (!response.ok) {
            console.error(`Status: ${response.status} ${response.statusText}`);
            const txt = await response.text();
            console.error('Response:', txt);
            return;
        }

        const json = await response.json();
        if (json.success && json.data && json.data.data.length > 0) {
            const firstRow = json.data.data[0];
            console.log('\n✅ API First Row Data Keys:', Object.keys(firstRow));
            console.log('✅ API First Row Data Values:', firstRow);

            // Explicitly check for shareAmount presence and value
            console.log('\nValue Check:');
            console.log('shareAmount:', firstRow.shareAmount, 'Type:', typeof firstRow.shareAmount);
            console.log('dividendAmount:', firstRow.dividendAmount, 'Type:', typeof firstRow.dividendAmount);
        } else {
            console.log('⚠️ API returned success but no data or error.', json);
        }

    } catch (err) {
        console.error('❌ Error:', err);
    } finally {
        await client.end();
    }
}

debugDividend();
