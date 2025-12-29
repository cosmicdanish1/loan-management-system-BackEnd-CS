const { Client } = require('pg');

async function createOfficeMaster() {
    const client = new Client({
        host: 'localhost',
        port: 5432,
        database: 'EMP_Espat_Society',
        user: 'postgres',
        password: 'Test@1212'
    });

    try {
        await client.connect();

        console.log('Creating office_master table...');

        await client.query(`
            CREATE TABLE IF NOT EXISTS office_master (
                officeno INTEGER PRIMARY KEY,
                office_name VARCHAR(100) NOT NULL
            );
        `);

        console.log('Populating office_master with initial data...');

        // Upsert data for offices 1-6 found in member_master
        const query = `
            INSERT INTO office_master (officeno, office_name)
            VALUES 
            (1, 'Head Office'),
            (2, 'City Branch'),
            (3, 'Suburban Branch'),
            (4, 'Regional Office'),
            (5, 'Zonal Office'),
            (6, 'Extension Counter')
            ON CONFLICT (officeno) DO UPDATE 
            SET office_name = EXCLUDED.office_name;
        `;

        await client.query(query);

        console.log('✅ office_master created and populated.');

        const res = await client.query("SELECT * FROM office_master");
        console.table(res.rows);

    } catch (err) {
        console.error('❌ Error:', err);
    } finally {
        await client.end();
    }
}

createOfficeMaster();
