
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

        const res = await client.query(`
            SELECT table_name 
            FROM information_schema.columns 
            WHERE column_name = 'username'
        `);
        console.log('Tables with "username" column:', res.rows);

    } catch (err) {
        console.error('Error:', err.message);
    } finally {
        await client.end();
    }
}

main();
