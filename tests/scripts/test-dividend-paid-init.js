const { Client } = require('pg');

async function testDividendPaid() {
    const client = new Client({
        host: 'localhost',
        port: 5432,
        database: 'EMP_Espat_Society',
        user: 'postgres',
        password: 'Test@1212'
    });

    try {
        await client.connect();

        console.log('--- CHECKING ledger TABLE ---');
        // Check filtering conditions used in repo
        const res = await client.query(`
            SELECT * FROM ledger 
            WHERE trans_type = 'DR' 
            AND LOWER(narration) LIKE '%dividend%' 
            LIMIT 5
        `);

        if (res.rows.length === 0) {
            console.log('❌ No ledger entries found for dividend (DR, %dividend%)');

            // Populate Dummy Data
            console.log('Populating Dummy Dividend Data...');

            // Get 5 active members
            const members = await client.query("SELECT mbno FROM member_master WHERE isactive='Y' LIMIT 5");
            if (members.rows.length === 0) {
                console.log('❌ No active members to attach dividend to!');
                return;
            }

            const today = new Date().toISOString().split('T')[0];

            for (let i = 0; i < members.rows.length; i++) {
                const mbno = members.rows[i].mbno;
                const amt = 500 + (i * 100);

                // Assuming 'ledger' has columns: trans_no, trans_date, mbno, trans_amt, trans_type, narration, receipt_vchr_no
                // We might need to handle trans_no if it's not auto-increment, let's check structure first actually.
            }
        } else {
            console.log('✅ Found Ledger Entries:', res.rows.length);
            console.table(res.rows[0]);
        }
    } catch (err) {
        console.error(err);
    } finally {
        await client.end();
    }
}

testDividendPaid();
