const fetch = require('node-fetch');
const { Client } = require('pg');

async function debugDividendDeep() {
    const client = new Client({
        host: 'localhost',
        port: 5432,
        database: 'EMP_Espat_Society',
        user: 'postgres',
        password: 'Test@1212'
    });

    try {
        await client.connect();

        console.log('🔍 Deep Debugging Dividend Data...');

        // 1. Get a sample member who DEFINITELY has share amount > 0
        const richMember = await client.query(`
            SELECT accno, cur_shareamt 
            FROM annualstatement 
            WHERE cur_shareamt > 0 
            LIMIT 1
        `);

        if (richMember.rows.length === 0) {
            console.log('❌ No annualstatement records with positive share amount found!');
        } else {
            const sample = richMember.rows[0];
            console.log(`\n✅ Found a member with shares: AccNo '${sample.accno}', Shares: ${sample.cur_shareamt}`);

            // Check if this member exists in member_master
            const mm = await client.query(`
                SELECT mbno, f_name, isactive, flg_retire 
                FROM member_master 
                WHERE mbno = $1
            `, [sample.accno]);

            if (mm.rows.length > 0) {
                console.log('✅ Member exists in Master:', mm.rows[0]);
            } else {
                console.log('⚠️ Member NOT found in Master using exact string match.');
                // Try trimming
                const mmTrim = await client.query(`
                    SELECT mbno FROM member_master WHERE TRIM(mbno) = TRIM($1)
                 `, [sample.accno]);
                if (mmTrim.rows.length > 0) console.log('✅ Match found via TRIM!');
            }
        }

        // 2. Call API again and check summary
        const url = `http://localhost:3001/api/v1/report/dividend-report?financialYear=2024-2025&dividendRate=10`;

        const response = await fetch(url);
        const json = await response.json();

        if (json.success) {
            console.log('\n📊 API Summary:', json.data.summary);

            // Filter finding one non-zero
            const nonZero = json.data.data.find(d => d.shareAmount > 0);
            if (nonZero) {
                console.log('✅ Found non-zero record in API:', nonZero);
            } else {
                console.log('❌ ALL API records have 0 shareAmount.');
            }
        }

    } catch (err) {
        console.error('Error:', err);
    } finally {
        await client.end();
    }
}

debugDividendDeep();
