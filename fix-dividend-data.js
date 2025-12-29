const { Client } = require('pg');

async function fixDividendData() {
    const client = new Client({
        host: 'localhost',
        port: 5432,
        database: 'EMP_Espat_Society',
        user: 'postgres',
        password: 'Test@1212'
    });

    try {
        await client.connect();

        console.log('Fetching valid members...');
        const members = await client.query("SELECT mbno FROM member_master WHERE isactive='Y' LIMIT 10");
        const validMbnos = members.rows.map(m => m.mbno);

        if (validMbnos.length === 0) {
            console.log('No valid members found!');
            return;
        }

        console.log('Updating Orphan Ledger Entries (Dividend)...');
        // Delete old dummy data first to avoid mess? Or just update.
        // Let's delete old dummy dividend data to be clean and insert fresh ones linked to real members.

        await client.query("DELETE FROM ledger WHERE trans_type = 'DR' AND LOWER(narration) LIKE '%dividend%'");

        console.log('Deleted old entries. Inserting new valid entries...');

        // Get Max Ledger ID
        const maxRes = await client.query("SELECT COALESCE(MAX(ledgerid), 0) as maxid FROM ledger");
        let nextLedgerId = parseInt(maxRes.rows[0].maxid) + 1;

        const query = `
            INSERT INTO ledger (ledgerid, trans_no, trans_date, mbno, trans_amt, trans_type, narration, receipt_vchr_no, pl_balance)
            VALUES ($1, $2, $3, $4, $5, 'DR', 'Dividend Payment 2024-25', $6, 0)
        `;

        const today = new Date();
        const baseDate = new Date(today.getFullYear(), today.getMonth(), 1); // Start of current month

        for (let i = 0; i < validMbnos.length; i++) {
            const mbno = validMbnos[i];
            const transNo = (96000 + i).toString();
            // receipt_vchr_no max len is 6
            const voucherNo = (90000 + i).toString(); // Use 5 digit number string
            const amount = 1500 + (i * 250);

            // Random date in last 3 months
            const date = new Date(baseDate);
            date.setDate(date.getDate() - (i * 2));

            await client.query(query, [nextLedgerId++, transNo, date, mbno, amount, voucherNo]);
            console.log(`Inserted Dividend for Member ${mbno}: ${amount}`);
        }

        console.log('✅ Data Fixed!');

    } catch (err) {
        console.error(err);
    } finally {
        await client.end();
    }
}

fixDividendData();
