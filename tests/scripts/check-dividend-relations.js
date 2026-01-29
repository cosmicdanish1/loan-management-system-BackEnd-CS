const { Client } = require('pg');

async function checkRelations() {
    const client = new Client({
        host: 'localhost',
        port: 5432,
        database: 'EMP_Espat_Society',
        user: 'postgres',
        password: 'Test@1212'
    });

    try {
        await client.connect();

        console.log('--- Checking Ledger vs Member Master ---');
        const res = await client.query(`
            SELECT l.mbno, l.trans_amt, m.f_name, m.mbno as master_mbno
            FROM ledger l
            LEFT JOIN member_master m ON m.mbno = l.mbno
            WHERE l.trans_type = 'DR' 
            AND LOWER(l.narration) LIKE '%dividend%'
            LIMIT 5
        `);

        console.table(res.rows);

        // If master_mbno is null, we have a mismatch.
        const orphans = res.rows.filter(r => !r.master_mbno);
        if (orphans.length > 0) {
            console.log('⚠️ ORPHAN LEDGER ENTRIES FOUND! Ledger mbno does not exist in member_master.');

            // Suggestion: Update ledger to point to valid members
            console.log('Fetching some valid member IDs...');
            const members = await client.query("SELECT mbno FROM member_master WHERE isactive='Y' LIMIT 5");
            console.log('Valid Members:', members.rows.map(m => m.mbno));
        } else {
            console.log('✅ All ledger entries match a member.');
        }

    } catch (err) {
        console.error(err);
    } finally {
        await client.end();
    }
}

checkRelations();
