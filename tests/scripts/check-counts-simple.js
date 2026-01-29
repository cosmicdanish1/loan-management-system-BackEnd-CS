const { Client } = require('pg');

async function checkCountsSimple() {
    const client = new Client({
        host: 'localhost',
        port: 5432,
        database: 'EMP_Espat_Society',
        user: 'postgres',
        password: 'Test@1212'
    });

    try {
        await client.connect();

        const active = await client.query(`SELECT COUNT(*) as c FROM member_master WHERE isactive='Y' AND flg_retire='N'`);
        const annual = await client.query(`SELECT COUNT(*) as c FROM annualstatement`);
        const linked = await client.query(`
                 SELECT COUNT(*) as c
                 FROM member_master m
                 JOIN annualstatement a ON a.accno = m.mbno
                 WHERE m.isactive='Y' AND m.flg_retire='N'
        `);

        console.log(`Active Members: ${active.rows[0].c}`);
        console.log(`Annual Stat Rows: ${annual.rows[0].c}`);
        console.log(`Linked Active Rows: ${linked.rows[0].c}`);

    } catch (err) {
        console.error(err);
    } finally {
        await client.end();
    }
}

checkCountsSimple();
