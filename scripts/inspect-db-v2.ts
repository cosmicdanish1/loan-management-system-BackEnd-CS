
import { Client } from 'pg';

async function main() {
    const client = new Client({
        host: 'localhost',
        port: 5432,
        user: 'postgres',
        password: 'Test@1212',
        database: 'EMP_Espat_Society',
    });

    try {
        await client.connect();

        // Search specifically for the users table
        const res = await client.query(`
            SELECT table_name 
            FROM information_schema.tables 
            WHERE table_name ILIKE '%user%'
        `);
        console.log('User-related tables:', res.rows);

        // If users exists, check its constraints
        const constraintRes = await client.query(`
            SELECT conname, contype 
            FROM pg_constraint 
            WHERE conrelid = 'users'::regclass
        `);
        console.log('Constraints on "users":', constraintRes.rows);

    } catch (err) {
        console.error('Error:', err.message);
    } finally {
        await client.end();
    }
}

main();
