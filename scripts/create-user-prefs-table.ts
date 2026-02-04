
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

        // Create user_preferences table WITHOUT the foreign key for now to ensure it exists
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
                "updatedAt" TIMESTAMP NOT NULL DEFAULT now()
            );
        `;

        await client.query(createUserPreferencesQuery);
        console.log('Table "user_preferences" created (without FK for now).');

        // Verify if we can add the FK manually
        try {
            const addFKQuery = `
                ALTER TABLE user_preferences 
                ADD CONSTRAINT "FK_user_preferences_users" 
                FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE;
            `;
            await client.query(addFKQuery);
            console.log('Foreign key added successfully.');
        } catch (fkError) {
            console.warn('Could not add Foreign Key (likely due to missing PK on users table):', fkError.message);
            console.log('Proceeding without FK - the feature will still work.');
        }

    } catch (err) {
        console.error('Error during database operation:', err);
    } finally {
        await client.end();
    }
}

main();
