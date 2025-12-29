const { Client } = require('pg');

async function debugInterestData() {
    console.log('--- DEBUGGING INTEREST LIST DATA ---');

    const client = new Client({
        host: 'localhost',
        port: 5432,
        database: 'EMP_Espat_Society',
        user: 'postgres',
        password: 'Test@1212'
    });

    try {
        await client.connect();

        // 1. Check Total Members
        const totalMembers = await client.query(`SELECT COUNT(*) FROM member_master`);
        console.log(`Total Members: ${totalMembers.rows[0].count}`);

        // 2. Check Active Members (Targeting the service filter)
        const activeMembers = await client.query(`
            SELECT COUNT(*) FROM member_master 
            WHERE isactive = 'Y' AND flg_retire = 'N'
        `);
        console.log(`Active Non-Retired Members: ${activeMembers.rows[0].count}`);

        // 3. Check Annual Statement Links
        const linkedMembers = await client.query(`
            SELECT COUNT(*) 
            FROM member_master m
            JOIN annualstatement a ON a.accno = m.mbno
            WHERE m.isactive = 'Y' AND m.flg_retire = 'N'
        `);
        console.log(`Active Members with Annual Statement: ${linkedMembers.rows[0].count}`);

        // 4. Check Sample Data of Active Members
        console.log('\n--- SAMPLE ACTIVE MEMBER DATA ---');
        const sampleRes = await client.query(`
            SELECT m.mbno, m.f_name, m.wingno, m.officeno, m.isactive, m.flg_retire 
            FROM member_master m
            WHERE m.isactive = 'Y' AND m.flg_retire = 'N'
            LIMIT 5
        `);
        console.table(sampleRes.rows);

        // 5. Check Wing Master Links
        if (sampleRes.rows.length > 0) {
            const sampleMbno = sampleRes.rows[0].mbno;
            const wingRes = await client.query(`
                SELECT m.mbno, m.wingno, w.wname 
                FROM member_master m
                LEFT JOIN wingmast w ON w.wingno = m.wingno
                WHERE m.mbno = $1
            `, [sampleMbno]);
            console.log('\n--- WING LINK CHECK ---');
            console.table(wingRes.rows);
        }

    } catch (err) {
        console.error(err);
    } finally {
        await client.end();
    }
}

debugInterestData();
