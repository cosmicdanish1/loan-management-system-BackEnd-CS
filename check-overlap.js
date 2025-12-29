const { Client } = require('pg');

async function checkJointData() {
    const client = new Client({
        host: 'localhost',
        port: 5432,
        database: 'EMP_Espat_Society',
        user: 'postgres',
        password: 'Test@1212'
    });

    try {
        await client.connect();

        console.log('Checking for valid Members with Shares...');
        const res = await client.query(`
            SELECT m.mbno, m.f_name, a.cur_shareamt 
            FROM member_master m
            JOIN annualstatement a ON CAST(a.accno AS VARCHAR) = CAST(m.mbno AS VARCHAR)
            WHERE a.cur_shareamt > 0
            LIMIT 5
        `);

        if (res.rows.length === 0) {
            console.log('❌ No overlapping members with shares found!');
            // Check overlaps without > 0 check
            const res2 = await client.query(`
                SELECT m.mbno, m.f_name, a.cur_shareamt 
                FROM member_master m
                JOIN annualstatement a ON CAST(a.accno AS VARCHAR) = CAST(m.mbno AS VARCHAR)
                LIMIT 5
            `);
            console.log('Overlaps (any amount):', res2.rows);
        } else {
            console.log('✅ Found Valid Data:', res.rows);
        }

    } catch (err) {
        console.error(err);
    } finally {
        await client.end();
    }
}

checkJointData();
