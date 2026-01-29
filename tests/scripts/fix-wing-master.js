const { Client } = require('pg');

async function fixWingMaster() {
    const client = new Client({
        host: 'localhost',
        port: 5432,
        database: 'EMP_Espat_Society',
        user: 'postgres',
        password: 'Test@1212'
    });

    try {
        await client.connect();

        console.log('Inserting Numeric-like Wing IDs into WingMaster...');

        const query = `
            INSERT INTO wingmast (wingno, wname, winstate)
            VALUES 
            ('1', 'Traffic Dept', 1),
            ('2', 'Engineering Dept', 1),
            ('3', 'Operating Dept', 1),
            ('4', 'Commercial Dept', 1),
            ('5', 'Signals & Telecom', 1),
            ('6', 'Account Dept', 1)
            ON CONFLICT (wingno) DO UPDATE 
            SET wname = EXCLUDED.wname;
        `;

        await client.query(query);
        console.log('✅ Wing Master Updated with matching IDs');

        const verify = await client.query("SELECT * FROM wingmast WHERE wingno IN ('1', '2', '3')");
        console.table(verify.rows);

    } catch (err) {
        console.error(err);
    } finally {
        await client.end();
    }
}

fixWingMaster();
