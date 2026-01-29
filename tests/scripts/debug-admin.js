const { Client } = require('pg');

async function checkAdminUser() {
    const client = new Client({
        host: 'localhost',
        port: 5432,
        database: 'EMP_Espat_Society',
        user: 'postgres',
        password: 'Test@1212',
    });

    try {
        await client.connect();
        console.log('Connected to database');

        const result = await client.query("SELECT userid, susername, spassword, enable_disable, login_status FROM usermaster WHERE susername = 'admin'");

        if (result.rows.length > 0) {
            console.log('Admin user found:', result.rows[0]);
        } else {
            console.log('Admin user NOT found');

            const allUsers = await client.query("SELECT susername FROM usermaster");
            console.log('All users in usermaster:', allUsers.rows.map(r => r.susername));
        }

    } catch (error) {
        console.error('Error:', error.message);
    } finally {
        await client.end();
    }
}

checkAdminUser();
