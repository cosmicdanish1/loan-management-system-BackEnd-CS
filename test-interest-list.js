const { Client } = require('pg');

async function testInterestList() {
    console.log('--- TESTING INTEREST LIST REPORT DATA [FRONTEND SIMULATION] ---');

    const client = new Client({
        host: 'localhost',
        port: 5432,
        database: 'EMP_Espat_Society',
        user: 'postgres',
        password: 'Test@1212'
    });

    try {
        await client.connect();

        // 1. Fetch Wings
        console.log('\n🔍 Step 1: Fetching Wing List');
        const wingRes = await client.query(`
            SELECT DISTINCT m.wingno as wing
            FROM member_master m
            LEFT JOIN annualstatement a ON a.accno = m.mbno
            WHERE m.isactive = 'Y' AND m.flg_retire = 'N'
            ORDER BY wing
        `);
        console.log('Wings Available:', wingRes.rows.map(r => r.wing));

        // 2. Fetch Data
        console.log('\n🔍 Step 2: Fetching Report Data (ALL Accounts)');

        const dataRes = await client.query(`
            SELECT 
                m.mbno as "memberNo",
                m.f_name as "memberName",
                m.wingno as wing,
                COALESCE(a.cur_triftamt, 0) as "cdBalance",
                COALESCE(a.cur_tfintrec, 0) as "mdBalance",
                COALESCE(a.cur_shareamt, 0) as "shareBalance"
            FROM member_master m
            LEFT JOIN annualstatement a ON a.accno = m.mbno
            WHERE m.isactive = 'Y' AND m.flg_retire = 'N'
            LIMIT 10
        `);

        // Calculate Interest
        const mappedData = dataRes.rows.map(row => {
            const cdBal = parseFloat(row.cdBalance);
            const mdBal = parseFloat(row.mdBalance);
            const shareBal = parseFloat(row.shareBalance);

            return {
                ...row,
                cdBalance: cdBal,
                mdBalance: mdBal,
                shareBalance: shareBal,
                cdInterest: (cdBal * 0.08).toFixed(2),
                mdInterest: (mdBal * 0.06).toFixed(2),
                shareInterest: (shareBal * 0.10).toFixed(2)
            };
        });

        if (mappedData.length > 0) {
            console.log(`✅ Loaded ${mappedData.length} active members.`);
            console.table(mappedData);

            // Check if balances are all zero
            const totalBal = mappedData.reduce((sum, r) => sum + r.cdBalance + r.mdBalance + r.shareBalance, 0);
            if (totalBal === 0) {
                console.log('⚠️ WARNING: All balances are ZERO. We might need to populate annualstatement.');
            } else {
                console.log('✅ Balances found.');
            }

        } else {
            console.log('⚠️ No active members found!');
        }

    } catch (err) {
        console.error(err);
    } finally {
        await client.end();
    }
}

testInterestList();
