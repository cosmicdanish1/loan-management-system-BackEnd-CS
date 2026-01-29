const { Client } = require('pg');

async function checkWingNumbers() {
    const client = new Client({
        host: 'localhost',
        port: 5432,
        database: 'EMP_Espat_Society',
        user: 'postgres',
        password: 'Test@1212'
    });

    await client.connect();

    // Check member_master wing numbers
    const memberWings = await client.query(`
    SELECT DISTINCT wingno 
    FROM member_master 
    WHERE wingno IS NOT NULL AND wingno != '' 
    ORDER BY wingno 
    LIMIT 10
  `);
    console.log('Wing numbers in member_master:', memberWings.rows.map(r => r.wingno));

    // Check division_master wing numbers
    const divWings = await client.query(`
    SELECT DISTINCT wingno 
    FROM division_master 
    ORDER BY wingno
  `);
    console.log('Wing numbers in division_master:', divWings.rows.map(r => r.wingno));

    // Get sample divisions with wing 1
    const divs1 = await client.query(`
    SELECT * FROM division_master WHERE wingno = '1' LIMIT 3
  `);
    console.log('\nSample divisions for wing 1:', JSON.stringify(divs1.rows, null, 2));

    await client.end();
}

checkWingNumbers();
