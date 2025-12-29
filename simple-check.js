const { Client } = require('pg');

async function checkWingTableSimple() {
    const client = new Client({
        host: 'localhost',
        port: 5432,
        database: 'EMP_Espat_Society',
        user: 'postgres',
        password: 'Test@1212'
    });

    try {
        await client.connect();

        console.log('Fetching columns for WINGMAST...');
        const res = await client.query("SELECT * FROM information_schema.columns WHERE table_name = 'wingmast'");
        res.rows.forEach(r => console.log(r.column_name, r.data_type));

        console.log('Fetching WINGMAST data...');
        const res2 = await client.query("SELECT * FROM wingmast");
        console.log(res2.rows);

    } catch (err) {
        console.error(err);
    } finally {
        await client.end();
    }
}

checkWingTableSimple();
