const { Client } = require('pg');

async function checkMember() {
    const client = new Client({
        host: 'localhost',
        port: 5432,
        database: 'EMP_Espat_Society',
        user: 'postgres',
        password: 'Test@1212'
    });

    try {
        await client.connect();

        console.log('Checking Member 1000001 in Master...');
        // Cast to varchar to avoid the error we saw before
        const res = await client.query("SELECT * FROM member_master WHERE CAST(mbno AS VARCHAR) = '1000001'");
        if (res.rows.length === 0) {
            console.log('❌ Member 1000001 NOT found in master');
        } else {
            console.log('✅ Found:', res.rows[0].f_name, res.rows[0].isactive);
        }

    } catch (err) {
        console.error(err);
    } finally {
        await client.end();
    }
}

checkMember();
