const { Client } = require('pg');

async function fixWingMasterFallback() {
    const client = new Client({
        host: 'localhost',
        port: 5432,
        database: 'EMP_Espat_Society',
        user: 'postgres',
        password: 'Test@1212'
    });

    try {
        await client.connect();

        console.log('Inserting Numeric-like Wing IDs via UPSERT fallback...');

        const wings = [
            { id: '1', name: 'Traffic Dept' },
            { id: '2', name: 'Engineering Dept' },
            { id: '3', name: 'Operating Dept' },
            { id: '4', name: 'Commercial Dept' },
            { id: '5', name: 'Signals & Telecom' },
            { id: '6', name: 'Account Dept' }
        ];

        for (const w of wings) {
            // Check if exists
            const check = await client.query("SELECT 1 FROM wingmast WHERE wingno = $1", [w.id]);
            if (check.rows.length === 0) {
                await client.query("INSERT INTO wingmast (wingno, wname, winstate) VALUES ($1, $2, 1)", [w.id, w.name]);
                console.log(`Inserted ${w.id}`);
            } else {
                await client.query("UPDATE wingmast SET wname = $2 WHERE wingno = $1", [w.id, w.name]);
                console.log(`Updated ${w.id}`);
            }
        }

        console.log('✅ Wing Master Updated');

    } catch (err) {
        console.error(err);
    } finally {
        await client.end();
    }
}

fixWingMasterFallback();
