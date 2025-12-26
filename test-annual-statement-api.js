const fetch = require('node-fetch');

async function testAnnualMemberStatementAPIs() {
    const API_BASE = 'http://localhost:3001/api/v1/report';

    console.log('=== Testing Annual Member Statement APIs ===\n');

    try {
        // Test 1: Get Wing List
        console.log('1️⃣  Testing Wing List API...');
        const wingRes = await fetch(`${API_BASE}/wing-list`);
        const wings = await wingRes.json();

        if (wingRes.ok) {
            const wingData = Array.isArray(wings) ? wings : wings.data;
            console.log(`✅ Success! Found ${wingData.length} wings`);
            console.log('Sample wing:', JSON.stringify(wingData[0], null, 2));
        } else {
            console.log('❌ Failed to get wings:', wings);
            return;
        }

        // Test 2: Get Division List (for a specific wing)
        console.log('\n2️⃣  Testing Division List API...');
        const testWingNo = '1'; // Using wing number 1
        const divRes = await fetch(`${API_BASE}/division-list?wingNo=${testWingNo}`);
        const divisions = await divRes.json();

        if (divRes.ok) {
            const divData = Array.isArray(divisions) ? divisions : divisions.data;
            console.log(`✅ Success! Found ${divData.length} divisions for wing ${testWingNo}`);
            console.log('Sample division:', JSON.stringify(divData[0], null, 2));
        } else {
            console.log('❌ Failed to get divisions:', divisions);
            return;
        }

        // Test 3: Get Annual Member Statement
        console.log('\n3️⃣  Testing Annual Member Statement API...');
        const params = new URLSearchParams({
            wingNo: testWingNo,
            officeNo: '1',
            asOnDate: '2025-12-26'
        });

        const stmtRes = await fetch(`${API_BASE}/annual-member-statement?${params.toString()}`);
        const statement = await stmtRes.json();

        if (stmtRes.ok) {
            const stmtData = Array.isArray(statement) ? statement : statement.data;
            console.log(`✅ Success! Found ${stmtData.length} annual statements`);
            if (stmtData.length > 0) {
                console.log('\nSample statement:');
                console.log(JSON.stringify(stmtData[0], null, 2));
            } else {
                console.log('\n⚠️  No statements found. This might be normal if no members match criteria.');
            }
        } else {
            console.log('❌ Failed to get statement:', statement);
            return;
        }

        console.log('\n✅ All API tests passed!\n');
        console.log('📋 Summary:');
        console.log('   - Wings API: ✅');
        console.log('   - Divisions API: ✅');
        console.log('   - Annual Statement API: ✅');
        console.log('\n🎯 Frontend should now load data from database with no hardcoding!');

    } catch (error) {
        console.error('\n❌ Test failed with error:', error.message);
        console.error(error.stack);
    }
}

testAnnualMemberStatementAPIs();
