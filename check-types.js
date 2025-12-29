const { Client } = require('pg');

async function checkTypes() {
    const client = new Client({
        host: 'localhost',
        port: 5432,
        database: 'EMP_Espat_Society',
        user: 'postgres',
        password: 'Test@1212'
    });

    try {
        await client.connect();

        const t1 = await client.query("SELECT data_type FROM information_schema.columns WHERE table_name = 'annualstatement' AND column_name = 'accno'");
        const t2 = await client.query("SELECT data_type FROM information_schema.columns WHERE table_name = 'member_master' AND column_name = 'mbno'");

        console.log('annualstatement.accno:', t1.rows[0]?.data_type);
        console.log('member_master.mbno:', t2.rows[0]?.data_type);

    } catch (err) {
        console.error(err);
    } finally {
        await client.end();
    }
}

checkTypes();
