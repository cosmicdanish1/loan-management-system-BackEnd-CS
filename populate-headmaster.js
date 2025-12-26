const { Client } = require('pg');

async function populateHeadMaster() {
    const client = new Client({
        user: 'postgres',
        host: 'localhost',
        database: 'EMP_Espat_Society',
        password: 'Test@1212',
        port: 5432,
    });

    const heads = [
        { code: 'A1001', head_name: 'Savings Account', parent_code: '0', headtype: 'ASST' },
        { code: 'A1002', head_name: 'Fixed Deposit', parent_code: '0', headtype: 'ASST' },
        { code: 'A1003', head_name: 'Recurring Deposit', parent_code: '0', headtype: 'ASST' },
        { code: 'A1004', head_name: 'Cash in Hand', parent_code: '0', headtype: 'ASST' },
        { code: 'A1005', head_name: 'Bank Account', parent_code: '0', headtype: 'ASST' },
        { code: 'L2001', head_name: 'Member Deposits', parent_code: '0', headtype: 'LIAB' },
        { code: 'I3001', head_name: 'Interest Income', parent_code: '0', headtype: 'INC' },
        { code: 'E4001', head_name: 'Interest Expense', parent_code: '0', headtype: 'EXP' },
        { code: 'E4002', head_name: 'Administrative Expenses', parent_code: '0', headtype: 'EXP' }
    ];

    try {
        await client.connect();
        console.log('Connected to DB');

        console.log('Populating headmaster table...');
        for (const head of heads) {
            await client.query(`
        INSERT INTO headmaster (code, head_name, parent_code, headtype)
        VALUES ($1, $2, $3, $4)
        ON CONFLICT (code) 
        DO UPDATE SET head_name = EXCLUDED.head_name, 
                      parent_code = EXCLUDED.parent_code, 
                      headtype = EXCLUDED.headtype
      `, [head.code, head.head_name, head.parent_code, head.headtype]);
            console.log(`✅ Processed: ${head.code} - ${head.head_name}`);
        }

        console.log('\nFinal verification:');
        const res = await client.query('SELECT * FROM headmaster ORDER BY code');
        console.table(res.rows);

    } catch (err) {
        console.error('Error populating headmaster:', err);
    } finally {
        await client.end();
    }
}

populateHeadMaster();
