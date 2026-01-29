const { Client } = require('pg');

async function updateHeadTypes() {
    const client = new Client({
        host: 'localhost',
        port: 5432,
        database: 'EMP_Espat_Society',
        user: 'postgres',
        password: 'Test@1212'
    });

    try {
        await client.connect();

        // Update types based on first letter convention for test data
        // A -> AST, L -> LIA, I -> INC, E -> EXP, P -> LIA (Provision?)

        await client.query("UPDATE headmaster SET headtype = 'AST' WHERE code LIKE 'A%' AND headtype = 'OTH'");
        await client.query("UPDATE headmaster SET headtype = 'LIA' WHERE code LIKE 'L%' AND headtype = 'OTH'");
        await client.query("UPDATE headmaster SET headtype = 'INC' WHERE code LIKE 'I%' AND headtype = 'OTH'");
        await client.query("UPDATE headmaster SET headtype = 'EXP' WHERE code LIKE 'E%' AND headtype = 'OTH'");

        console.log('✅ Updated head types for consistency');

    } catch (e) {
        console.error(e);
    } finally {
        await client.end();
    }
}

updateHeadTypes();
