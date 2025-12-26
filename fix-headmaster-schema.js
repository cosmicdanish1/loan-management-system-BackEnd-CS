const { Client } = require('pg');

async function fixHeadMaster() {
    const client = new Client({
        user: 'postgres',
        host: 'localhost',
        database: 'EMP_Espat_Society',
        password: 'Test@1212',
        port: 5432,
    });

    try {
        await client.connect();
        console.log('Connected to DB');

        console.log('Adding Primary Key to headmaster(code)...');
        // First remove any possible duplicates if they exist (just in case)
        await client.query(`
      DELETE FROM headmaster a USING (
        SELECT MIN(ctid) as ctid, code
        FROM headmaster 
        GROUP BY code HAVING COUNT(*) > 1
      ) b
      WHERE a.code = b.code AND a.ctid <> b.ctid
    `);

        // Add Primary Key
        await client.query('ALTER TABLE headmaster ADD PRIMARY KEY (code)');
        console.log('✅ Primary Key added successfully');

    } catch (err) {
        console.error('Error fixing headmaster:', err.message);
    } finally {
        await client.end();
    }
}

fixHeadMaster();
