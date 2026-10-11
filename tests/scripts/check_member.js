const { Client } = require('pg');
require('dotenv').config();

async function checkMember() {
    const connectionString = `postgresql://${process.env.DB_USERNAME || 'postgres'}:${encodeURIComponent(process.env.DB_PASSWORD || '')}@${process.env.DB_HOST || 'localhost'}:${process.env.DB_PORT || 5432}/${process.env.DB_DATABASE || 'EMP_Espat_Society'}`;
    const client = new Client({ connectionString });

    try {
        await client.connect();

        console.log('Querying member_master for mbno:');
        const resMm = await client.query("SELECT mbno, f_name, l_name FROM member_master WHERE mbno = 940031302");
        console.table(resMm.rows);

        const resMmText = await client.query("SELECT mbno, f_name, l_name FROM member_master WHERE mbno::text = '940031302'");
        console.table(resMmText.rows);

    } catch (err) {
        console.error(err.message);
    } finally {
        await client.end();
    }
}

checkMember();
