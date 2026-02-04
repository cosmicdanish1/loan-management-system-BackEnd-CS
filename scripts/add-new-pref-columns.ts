import { Client } from 'pg';
import * as dotenv from 'dotenv';
import * as path from 'path';

// Load environment variables manually
dotenv.config({ path: path.resolve(__dirname, '../.env') });

const dbConfig = {
    host: process.env.DB_HOST || 'localhost',
    port: parseInt(process.env.DB_PORT || '5432'),
    user: process.env.DB_USERNAME || 'postgres',
    password: process.env.DB_PASSWORD || 'postgres',
    database: process.env.DB_DATABASE || 'loan_management_db',
};

async function addMissingColumns() {
    const client = new Client(dbConfig);

    try {
        await client.connect();
        console.log(`Connected to database: ${dbConfig.database}`);

        const columns = [
            { name: 'fontFamily', type: 'VARCHAR', default: "'Inter'" },
            { name: 'backgroundType', type: 'VARCHAR', default: "'solid'" },
            { name: 'backgroundColor1', type: 'VARCHAR', default: "'#ffffff'" },
            { name: 'backgroundColor2', type: 'VARCHAR', default: "'#000000'" },
            { name: 'backgroundImage', type: 'TEXT', default: "NULL" },
            { name: 'textColor', type: 'VARCHAR', default: "'#1f2937'" },
            { name: 'notifications', type: 'BOOLEAN', default: "TRUE" },
            { name: 'syncAcrossWindows', type: 'BOOLEAN', default: "TRUE" },
            { name: 'soundEffects', type: 'BOOLEAN', default: "TRUE" },
            { name: 'inactivityLogout', type: 'BOOLEAN', default: "TRUE" },
            { name: 'inactivityTimeoutMinutes', type: 'INTEGER', default: "60" }
        ];

        for (const col of columns) {
            try {
                const checkQuery = `
          SELECT column_name 
          FROM information_schema.columns 
          WHERE table_name='user_preferences' AND column_name='${col.name}';
        `;
                const res = await client.query(checkQuery);

                if (res.rowCount === 0) {
                    console.log(`Adding missing column: ${col.name}`);
                    // Add column if it doesn't exist
                    let alterQuery = `ALTER TABLE "user_preferences" ADD COLUMN "${col.name}" ${col.type}`;
                    if (col.default !== "NULL") {
                        alterQuery += ` DEFAULT ${col.default}`;
                    }
                    await client.query(alterQuery);
                    console.log(`✓ Added ${col.name}`);
                } else {
                    console.log(`- Column ${col.name} already exists.`);
                }
            } catch (err) {
                console.error(`Error adding column ${col.name}:`, err);
            }
        }

        console.log('Schema update complete.');

    } catch (err) {
        console.error('Database connection error:', err);
    } finally {
        await client.end();
    }
}

addMissingColumns();
