const { Client } = require('pg');

async function updateHeadNames() {
    const client = new Client({
        user: 'postgres', host: 'localhost', database: 'EMP_Espat_Society', password: 'Test@1212', port: 5432,
    });

    const mappings = [
        { code: 'A1001', name: 'CASH IN HAND' },
        { code: 'A1002', name: 'REGULAR LOAN' },
        { code: 'E4001', name: 'INTEREST EXPENSE' },
        { code: 'E4002', name: 'ADMINISTRATIVE EXPENSES' },
        { code: 'I3001', name: 'INTEREST INCOME' }
    ];

    try {
        await client.connect();
        console.log('Connected to DB');

        for (const m of mappings) {
            await client.query(
                'INSERT INTO headmaster (code, head_name) VALUES ($1, $2) ON CONFLICT (code) DO UPDATE SET head_name = EXCLUDED.head_name',
                [m.code, m.name]
            );
            console.log(`✅ Updated ${m.code} -> ${m.name}`);
        }

    } catch (err) {
        console.error('Error:', err);
    } finally {
        await client.end();
    }
}

updateHeadNames();
