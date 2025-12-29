const { Client } = require('pg');

async function checkMemberShares() {
    const client = new Client({
        host: 'localhost',
        port: 5432,
        database: 'EMP_Espat_Society',
        user: 'postgres',
        password: 'Test@1212'
    });

    try {
        await client.connect();

        console.log('Checking Member 30001358...');
        const res = await client.query("SELECT * FROM annualstatement WHERE accno = '30001358'");
        if (res.rows.length === 0) {
            console.log('❌ No annual statement for 30001358');
        } else {
            console.log('✅ Found:', res.rows[0]);
        }

        console.log('\nChecking Member 1000001...');
        const res2 = await client.query("SELECT * FROM annualstatement WHERE accno = '1000001'");
        if (res2.rows.length === 0) {
            console.log('❌ No annual statement for 1000001');
        } else {
            console.log('✅ Found:', res2.rows[0]);
        }

    } catch (err) {
        console.error(err);
    } finally {
        await client.end();
    }
}

checkMemberShares();
