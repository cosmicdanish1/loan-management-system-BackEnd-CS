
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
            FROM information_schema.tables 
            WHERE table_schema = 'public'
        `);
        console.log('Tables in database:', res.rows.map(r => r.table_name).join(', '));

        const cols = await client.query(`
            SELECT column_name, data_type 
            FROM information_schema.columns 
            WHERE table_name = 'users'
        `);
        console.log('Columns in "users" table:', cols.rows);

    } catch (err) {
        console.error('Error:', err);
    } finally {
        await client.end();
    }
}

main();
