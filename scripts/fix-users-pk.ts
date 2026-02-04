
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
            SELECT id, COUNT(*) 
            FROM users 
            GROUP BY id 
            HAVING COUNT(*) > 1
        `);
        console.log('Duplicate IDs in users:', res.rows);

        if (res.rows.length === 0) {
            console.log('No duplicates found. Safe to add PK.');
            await client.query('ALTER TABLE users ADD PRIMARY KEY (id)');
            console.log('Primary Key added to "users" table.');

            // Now try adding the FK to user_preferences
            await client.query(`
                ALTER TABLE user_preferences 
                ADD CONSTRAINT "FK_user_preferences_users" 
                FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE;
            `);
            console.log('Foreign Key added successfully to "user_preferences".');
        } else {
            console.warn('Duplicates found! Cannot add PK automatically.');
        }

    } catch (err) {
        console.error('Error:', err.message);
    } finally {
        await client.end();
    }
}

main();
