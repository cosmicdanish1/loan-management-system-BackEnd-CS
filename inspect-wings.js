const { Client } = require('pg');

async function checkWingTable() {
    const client = new Client({
        host: 'localhost',
        port: 5432,
        database: 'EMP_Espat_Society',
        user: 'postgres',
        password: 'Test@1212'
    });

    try {
        await client.connect();

        console.log('--- WINGMAST Structure ---');
        const s1 = await client.query("SELECT CAST(column_name AS VARCHAR), CAST(data_type AS VARCHAR) FROM information_schema.columns WHERE table_name = 'wingmast'");
        console.table(s1.rows);

        console.log('\n--- WINGMAST Data ---');
        const d1 = await client.query("SELECT * FROM wingmast LIMIT 5");
        console.table(d1.rows);

        // Also check if there's any table with 'office' in name
        console.log('\n--- Office Tables ---');
        const t = await client.query("SELECT CAST(table_name AS VARCHAR) FROM information_schema.tables WHERE table_name LIKE '%office%'");
        console.table(t.rows);

    } catch (err) {
        console.error(err);
    } finally {
        await client.end();
    }
}

checkWingTable();
