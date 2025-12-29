const { Client } = require('pg');

async function fixAmountTypes() {
    const client = new Client({
        host: 'localhost',
        port: 5432,
        database: 'EMP_Espat_Society',
        user: 'postgres',
        password: 'Test@1212'
    });

    try {
        await client.connect();
        console.log('✅ Connected to database');

        // Find varchar columns that look like amounts
        const query = `
            SELECT table_name, column_name, data_type 
            FROM information_schema.columns 
            WHERE table_schema = 'public' 
            AND data_type = 'character varying'
            AND (
                column_name ILIKE '%amount%' OR 
                column_name ILIKE '%amt%' OR 
                column_name ILIKE '%balance%' OR 
                column_name ILIKE '%bal%' OR 
                column_name ILIKE '%share%' OR 
                column_name ILIKE '%loan%' OR 
                column_name ILIKE 'cr' OR 
                column_name ILIKE 'dr' OR
                column_name ILIKE '%cr' OR
                column_name ILIKE '%dr'
            )
        `;

        const res = await client.query(query);
        console.log(`Found ${res.rows.length} potential varchar amount columns.`);

        for (const row of res.rows) {
            const { table_name, column_name } = row;
            console.log(`Fixing ${table_name}.${column_name}...`);

            try {
                // Alter column type to numeric, using USING clause to handle non-numeric strings
                // We remove commas and other non-numeric chars
                await client.query(`
                    ALTER TABLE "${table_name}" 
                    ALTER COLUMN "${column_name}" TYPE numeric 
                    USING (NULLIF(regexp_replace("${column_name}", '[^0-9.]', '', 'g'), '')::numeric)
                `);
                console.log(`  ✅ Converted ${table_name}.${column_name} to numeric`);
            } catch (err) {
                console.error(`  ❌ Failed to convert ${table_name}.${column_name}: ${err.message}`);
            }
        }

        console.log('\n--- Converting money types to numeric for better handling ---');
        const moneyCols = await client.query(`
            SELECT table_name, column_name 
            FROM information_schema.columns 
            WHERE table_schema = 'public' 
            AND data_type = 'money'
        `);
        console.log(`Found ${moneyCols.rows.length} money columns.`);

        for (const row of moneyCols.rows) {
            const { table_name, column_name } = row;
            console.log(`Converting ${table_name}.${column_name} to numeric...`);
            try {
                await client.query(`
                    ALTER TABLE "${table_name}" 
                    ALTER COLUMN "${column_name}" TYPE numeric 
                    USING ("${column_name}"::numeric)
                `);
                console.log(`  ✅ Converted ${table_name}.${column_name} to numeric`);
            } catch (err) {
                console.error(`  ❌ Failed to convert ${table_name}.${column_name}: ${err.message}`);
            }
        }

    } catch (err) {
        console.error('Database error:', err);
    } finally {
        await client.end();
    }
}

fixAmountTypes();
