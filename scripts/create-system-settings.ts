
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
        console.log('Connected to database: EMP_Espat_Society');

        // 1. Ensure system_settings table
        const createSystemSettingsQuery = `
            CREATE TABLE IF NOT EXISTS system_settings (
                "key" varchar PRIMARY KEY,
                "value" text,
                "createdAt" TIMESTAMP NOT NULL DEFAULT now(),
                "updatedAt" TIMESTAMP NOT NULL DEFAULT now()
            );
        `;
        await client.query(createSystemSettingsQuery);
        console.log('Table "system_settings" ensured.');

        // 2. Ensure user_preferences table (with correct reference to "users")
        const createUserPreferencesQuery = `
            CREATE TABLE IF NOT EXISTS user_preferences (
                "id" SERIAL PRIMARY KEY,
                "userId" integer NOT NULL,
                "interfaceMode" varchar DEFAULT 'light',
                "accentColor" varchar DEFAULT '#6366f1',
                "fontScale" float8 DEFAULT 1.0,
                "density" float8 DEFAULT 1.0,
                "cornerRadius" integer DEFAULT 8,
                "createdAt" TIMESTAMP NOT NULL DEFAULT now(),
                "updatedAt" TIMESTAMP NOT NULL DEFAULT now(),
                CONSTRAINT "FK_user_preferences_users" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE
            );
        `;
        try {
            await client.query(createUserPreferencesQuery);
            console.log('Table "user_preferences" ensured.');
        } catch (e) {
            if (e.message.includes('already exists')) {
                console.log('Table "user_preferences" already exists.');
            } else {
                console.error('Error creating user_preferences:', e.message);
            }
        }

        // 3. Insert default welcome text
        const insertDefaultQuery = `
            INSERT INTO system_settings ("key", "value")
            VALUES ('welcomeText', 'Cooperative Society Bhi')
            ON CONFLICT ("key") DO NOTHING;
        `;
        await client.query(insertDefaultQuery);
        console.log('Default welcomeText inserted.');

    } catch (err) {
        console.error('Error during database operation:', err);
    } finally {
        await client.end();
    }
}

main();
