const { Client } = require('pg');

async function testAnnualMemberStatement() {
    console.log('--- TESTING ANNUAL MEMBER STATEMENT REPORT ---');

    const client = new Client({
        host: 'localhost',
        port: 5432,
        database: 'EMP_Espat_Society',
        user: 'postgres',
        password: 'Test@1212'
    });

    try {
        await client.connect();
        console.log('✅ Connected to database');

        // 1. Simulating Wing/Branch selection
        console.log('\n1. Fetching available Wing and Office with members...');
        const wingParams = await client.query(`
            SELECT wm.wingno, wm.wname 
            FROM wingmast wm 
            JOIN member_master mm ON wm.wingno = mm.wingno 
            GROUP BY wm.wingno, wm.wname 
            LIMIT 1
        `);
        if (wingParams.rows.length === 0) {
            console.error('❌ No wings with members found');
            return;
        }
        const wingNo = wingParams.rows[0].wingno;
        const wingName = wingParams.rows[0].wname;
        console.log(`   Selected Wing: ${wingName} (${wingNo})`);

        const officeParams = await client.query('SELECT officeno, name FROM division_master WHERE wingno = $1 LIMIT 1', [wingNo]);
        const officeNo = officeParams.rows.length > 0 ? officeParams.rows[0].officeno : null;
        console.log(`   Selected Office: ${officeParams.rows.length > 0 ? officeParams.rows[0].name : 'NONE'} (${officeNo})`);

        // 2. Running the report query (same logic as in Service)
        console.log('\n2. Running Report Query...');
        let query = `
            SELECT 
                a.accno as "accountNo",
                a.op_triftamt, a.cur_triftamt,
                a.op_shareamt, a.cur_shareamt,
                a.rlbalance, a.tlbalance,
                mm.mbno, mm.f_name, mm.l_name
            FROM annualstatement a
            LEFT JOIN member_master mm ON a.accno::text = mm.mbno::text
            WHERE 1=1
        `;
        const params = [];
        let pIdx = 1;
        if (wingNo) { query += ` AND mm.wingno = $${pIdx}`; params.push(wingNo); pIdx++; }
        if (officeNo) { query += ` AND mm.officeno = $${pIdx}`; params.push(officeNo); pIdx++; }

        const res = await client.query(query, params);
        console.log(`   Found ${res.rows.length} records matching criteria.`);

        if (res.rows.length > 0) {
            console.log('\n3. Data Integrity Check (First Record):');
            const item = res.rows[0];
            console.log(`   - Account: ${item.accountNo}`);
            console.log(`   - Member: ${item.f_name} ${item.l_name || ''} (${item.mbno})`);

            // Check if amounts are numeric
            const checkNumeric = (val, name) => {
                const type = typeof val;
                const isNum = !isNaN(parseFloat(val));
                console.log(`   - ${name}: ${val} (${type}) -> ${isNum ? 'VALID NUMERIC' : '❌ INVALID'}`);
            };

            checkNumeric(item.cur_triftamt, 'Thrift Amount');
            checkNumeric(item.cur_shareamt, 'Share Amount');

            if (item.mbno === null) {
                console.error('   ❌ FAILED: Member info missing for account ' + item.accountNo);
            } else {
                console.log('   ✅ PASSED: Member info correctly joined');
            }
        } else {
            console.log('\n--- No matching data, checking fallback (All Records) ---');
            const fallbackRes = await client.query('SELECT COUNT(*) FROM annualstatement');
            console.log(`   Total records in annualstatement: ${fallbackRes.rows[0].count}`);
        }

        // 4. Checking Society Details
        console.log('\n4. Checking Society Details...');
        const socRes = await client.query('SELECT name, address FROM society_details LIMIT 1');
        if (socRes.rows.length > 0) {
            console.log(`   ✅ Society info found: ${socRes.rows[0].name}`);
        } else {
            console.warn('   ⚠️ Society details table empty. Using defaults.');
        }

    } catch (err) {
        console.error('❌ Test failed:', err);
    } finally {
        await client.end();
        console.log('\n--- TEST COMPLETE ---');
    }
}

testAnnualMemberStatement();
