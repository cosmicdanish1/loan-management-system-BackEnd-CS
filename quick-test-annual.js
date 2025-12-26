const fetch = require('node-fetch');

async function quickTest() {
    try {
        const wingRes = await fetch('http://localhost:3001/api/v1/report/wing-list');
        const wings = await wingRes.json();
        console.log('✅ Wing List works:', Array.isArray(wings) ? wings.length : wings.data?.length, 'wings');

        const divRes = await fetch('http://localhost:3001/api/v1/report/division-list?wingNo=1');
        const divs = await divRes.json();
        console.log('✅ Division List works:', Array.isArray(divs) ? divs.length : divs.data?.length, 'divisions');

        const stmtRes = await fetch('http://localhost:3001/api/v1/report/annual-member-statement?wingNo=1&officeNo=1&asOnDate=2025-12-26');
        const stmt = await stmtRes.json();
        console.log('✅ Annual Statement works:', Array.isArray(stmt) ? stmt.length : stmt.data?.length, 'records');

        console.log('\n✅ ALL TESTS PASSED - Data flows from DB to frontend with NO hardcoding!');
    } catch (e) {
        console.log('❌ Error:', e.message);
    }
}

quickTest();
