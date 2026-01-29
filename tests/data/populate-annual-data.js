const { Client } = require('pg');

async function populateInterestData() {
    console.log('--- POPULATING INTEREST DATA (ANNUALSTATEMENT) ---');

    const client = new Client({
        host: 'localhost',
        port: 5432,
        database: 'EMP_Espat_Society',
        user: 'postgres',
        password: 'Test@1212'
    });

    try {
        await client.connect();

        // 1. Fetch 50 Active Members without Annual Statement
        const membersRes = await client.query(`
            SELECT m.mbno, m.wingno 
            FROM member_master m
            LEFT JOIN annualstatement a ON a.accno = m.mbno
            WHERE m.isactive = 'Y' 
            AND m.flg_retire = 'N' 
            AND a.accno IS NULL
            LIMIT 50
        `);

        if (membersRes.rows.length === 0) {
            console.log('No eligible members found to populate.');
            return;
        }

        console.log(`Found ${membersRes.rows.length} members to populate.`);

        // 2. Insert Data
        let inserted = 0;
        for (const m of membersRes.rows) {
            // Generate random reasonable balances
            const cdBal = Math.floor(Math.random() * 50000) + 10000;
            const mdBal = Math.floor(Math.random() * 200000) + 50000;
            const shareBal = Math.floor(Math.random() * 5000) + 1000;

            await client.query(`
                INSERT INTO annualstatement (
                    accno, 
                    op_triftamt, cur_triftamt, 
                    op_tfintrec, cur_tfintrec, 
                    op_shareamt, cur_shareamt
                ) VALUES (
                    $1, 
                    $2, $2,  -- Opening = Closing for simplicity
                    $3, $3, 
                    $4, $4
                )
            `, [m.mbno, cdBal, mdBal, shareBal]);
            inserted++;
        }

        console.log(`✅ Successfully inserted ${inserted} records into annualstatement.`);

        // 3. Ensure Wing Names exist for these members
        // Get unique wing numbers from the populated members
        const wings = [...new Set(membersRes.rows.map(m => m.wingno).filter(w => w))];

        for (const wingNo of wings) {
            // Check if wing exists in wingmast
            const wCheck = await client.query(`SELECT 1 FROM wingmast WHERE wingno = $1`, [wingNo]);
            if (wCheck.rowCount === 0) {
                // Insert generic wing name if missing
                await client.query(`
                    INSERT INTO wingmast (wingno, wname) VALUES ($1, $2)
                `, [wingNo, `Wing ${wingNo}`]);
                console.log(`Created missing wing: ${wingNo}`);
            }
        }
        console.log('✅ Wing Master verification complete.');

    } catch (err) {
        console.error('Error populating data:', err);
    } finally {
        await client.end();
    }
}

populateInterestData();
