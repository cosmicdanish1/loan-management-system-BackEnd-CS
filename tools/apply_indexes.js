const { Client } = require('pg');
require('dotenv').config({ path: '../.env' });

const config = {
    host: process.env.DB_HOST || 'localhost',
    port: parseInt(process.env.DB_PORT) || 5432,
    user: process.env.DB_USERNAME || 'postgres',
    password: process.env.DB_PASSWORD || 'postgres',
    database: process.env.DB_DATABASE || 'loan_management_db',
};

async function applyIndexes() {
    const client = new Client(config);
    try {
        await client.connect();
        console.log("--- Applying Performance Indexes ---\n");

        const queries = [
            // 1. member_master
            "CREATE INDEX IF NOT EXISTS idx_member_master_mbno ON member_master (mbno)",
            "CREATE INDEX IF NOT EXISTS idx_member_master_office_wing ON member_master (officeno, wingno)",

            // 2. loan_pending
            "CREATE INDEX IF NOT EXISTS idx_loan_pending_case_mbno ON loan_pending (loancaseno, mbno)",

            // 3. loan_master
            "CREATE INDEX IF NOT EXISTS idx_loan_master_case_mbno ON loan_master (loancaseno, mbno)",

            // 4. ledger
            "CREATE INDEX IF NOT EXISTS idx_ledger_mbno ON ledger (mbno)",
            "CREATE INDEX IF NOT EXISTS idx_ledger_date ON ledger (trans_date)",

            // 5. transactions
            "CREATE INDEX IF NOT EXISTS idx_transactions_vchr_no ON transactions (receipt_vchr_no)"
        ];

        for (const query of queries) {
            console.log(`Executing: ${query}`);
            await client.query(query);
            console.log("✅ Success\n");
        }

        console.log("--- All indexes applied successfully! ---");

    } catch (err) {
        console.error("❌ Error applying indexes:", err.message);
    } finally {
        await client.end();
    }
}

applyIndexes();
