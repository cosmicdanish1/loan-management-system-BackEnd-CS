const { Client } = require('pg');
const dotenv = require('dotenv');
const path = require('path');

dotenv.config({ path: path.join(__dirname, '../.env') });

const config = {
    user: process.env.DB_USERNAME || 'postgres',
    password: process.env.DB_PASSWORD || 'postgres',
    host: process.env.DB_HOST || 'localhost',
    port: process.env.DB_PORT || 5432,
    database: process.env.DB_DATABASE || 'loan_mgmt'
};

const businessRules = [
    // Loan Parameters - Loan Against R
    { key: 'RULE_LOAN_R_MAX_AMT', name: 'Max Amount (Loan Against R)', value: '100000', type: 'number', cat: 'business_rules' },
    { key: 'RULE_LOAN_R_RATE', name: 'Interest Rate (Loan Against R)', value: '12.0', type: 'percentage', cat: 'business_rules' },
    { key: 'RULE_LOAN_R_INSTALLMENTS', name: 'Installments (Loan Against R)', value: '60', type: 'number', cat: 'business_rules' },
    { key: 'RULE_LOAN_R_GUARANTORS', name: 'Guarantors (Loan Against R)', value: '2', type: 'number', cat: 'business_rules' },

    // Loan Parameters - Long Term Loan
    { key: 'RULE_LOAN_LT_MAX_AMT', name: 'Max Amount (Long Term)', value: '500000', type: 'number', cat: 'business_rules' },
    { key: 'RULE_LOAN_LT_RATE', name: 'Interest Rate (Long Term)', value: '10.5', type: 'percentage', cat: 'business_rules' },

    // Loan Against Deposits
    { key: 'RULE_LOAN_DEP_SHARE_VAL_PCT', name: 'Share Value Percentage', value: '90', type: 'percentage', cat: 'business_rules' },
    { key: 'RULE_LOAN_DEP_FD_PCT', name: 'FD Percentage', value: '80', type: 'percentage', cat: 'business_rules' },
    { key: 'RULE_LOAN_DEP_OVERALL_LIMIT', name: 'Overall Limit (Loan on Deposit)', value: '1000000', type: 'number', cat: 'business_rules' },

    // General Rules
    { key: 'RULE_MEMBER_MIN_TENURE_MONTHS', name: 'Min Membership (Months)', value: '6', type: 'number', cat: 'business_rules' },
    { key: 'RULE_PENAL_RATE', name: 'General Penal Rate', value: '2.0', type: 'percentage', cat: 'business_rules' },

    // System Settings
    { key: 'SYS_DATA_ENTRY_MODE', name: 'Data Entry Mode', value: 'false', type: 'boolean', cat: 'system_settings' },
    { key: 'SYS_PRINT_DEMAND_HORIZONTAL', name: 'Print Demand Horizontal', value: 'false', type: 'boolean', cat: 'system_settings' },
    { key: 'SYS_USE_REDUCING_BALANCE', name: 'Use Reducing Balance', value: 'true', type: 'boolean', cat: 'system_settings' },
    { key: 'SYS_MIN_SAVINGS_BALANCE', name: 'Min Savings Balance', value: '500', type: 'number', cat: 'system_settings' },
    { key: 'SYS_PROFIT_HEAD', name: 'Profit Ledger Head', value: 'PROFIT_2024', type: 'string', cat: 'system_settings' }
];

async function seed() {
    const client = new Client(config);
    try {
        await client.connect();
        console.log('Connected to database');

        // Ensure unique index exists on key
        await client.query('CREATE UNIQUE INDEX IF NOT EXISTS "UQ_system_configs_key" ON system_configs(key)');
        console.log('Ensured unique index on key');

        for (const rule of businessRules) {
            const query = `
                INSERT INTO system_configs (key, name, value, "dataType", category, "isActive", "isReadonly")
                VALUES ($1, $2, $3, $4, $5, true, false)
                ON CONFLICT (key) DO UPDATE 
                SET value = EXCLUDED.value, 
                    name = EXCLUDED.name,
                    "updatedAt" = CURRENT_TIMESTAMP;
            `;
            await client.query(query, [rule.key, rule.name, rule.value, rule.type, rule.cat]);
            console.log(`Seeded rule: ${rule.key}`);
        }

        console.log('Business rules seeding completed successfully');
    } catch (err) {
        console.error('Error seeding business rules:', err);
    } finally {
        await client.end();
    }
}

seed();
