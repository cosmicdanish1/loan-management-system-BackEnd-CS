const { Client } = require('pg');

async function verifyDividendPaidAPI() {
    const client = new Client({
        host: 'localhost',
        port: 5432,
        database: 'EMP_Espat_Society',
        user: 'postgres',
        password: 'Test@1212'
    });

    try {
        await client.connect();

        console.log('--- VERIFYING API QUERY LOGIC ---');

        const query = `
            SELECT 
                l.trans_no as "transactionNo",
                l.trans_date as "paymentDate",
                l.mbno as "memberNo",
                CONCAT(m.prefix, ' ', m.f_name, ' ', COALESCE(m.m_name, ''), ' ', COALESCE(m.l_name, '')) as "memberName",
                COALESCE(w.wname, m.wingno) as wing,
                m.desig as designation,
                CAST(l.trans_amt AS numeric) as amount,
                l.receipt_vchr_no as "voucherNo"
            FROM ledger l
            LEFT JOIN member_master m ON m.mbno = l.mbno
            LEFT JOIN wingmast w ON w.wingno = m.wingno
            WHERE l.trans_type = 'DR' 
            AND LOWER(l.narration) LIKE '%dividend%'
            LIMIT 5
        `;

        const res = await client.query(query);
        console.table(res.rows);

    } catch (err) {
        console.error(err);
    } finally {
        await client.end();
    }
}

verifyDividendPaidAPI();
