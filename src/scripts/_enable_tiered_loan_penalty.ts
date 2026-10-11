import 'dotenv/config';
// One-off: switches the tiered late-payment penalty ON for all loans, the same two settings the
// Modify Business Rules screen writes when "Enable tiered penalties for all loans" is saved:
//   RULE_TIERED_LOAN_PENALTY_ENABLED = true
//   RULE_TIERED_LOAN_PENALTY_ACTIVATION_DATE = today   (penalties never backdate before this)
// Same UPDATE-then-INSERT-if-absent shape as UtilitiesService.upsertSystemConfigs. To switch it off again,
// untick the same toggle on that screen (or set the first value to 'false').
import { DataSource } from 'typeorm';

const ds = new DataSource({
    type: 'postgres', host: 'localhost', port: 5432, database: 'EMP_Espat_Society',
    username: 'postgres', password: process.env.DB_PASSWORD, entities: [], synchronize: false, logging: false,
});

async function upsert(key: string, value: string, dataType: string) {
    const updated = await ds.query(
        `UPDATE system_configs SET value = $1, "dataType" = $2, "isActive" = true, "updatedAt" = NOW() WHERE key = $3 RETURNING id`,
        [value, dataType, key],
    );
    const rows = Array.isArray(updated[0]) ? updated[0] : updated; // [rows, count] shape
    if (rows.length === 0) {
        await ds.query(
            `INSERT INTO system_configs (key, name, value, "dataType", category, "isActive", "isReadonly", "createdAt", "updatedAt")
             VALUES ($1, $2, $3, $4, 'business_rules', true, false, NOW(), NOW())`,
            [key, key.replace(/_/g, ' ').toLowerCase(), value, dataType],
        );
    }
}

async function main() {
    await ds.initialize();
    const before = await ds.query(`SELECT key, value FROM system_configs WHERE key LIKE 'RULE_TIERED%'`);
    console.log('before:', JSON.stringify(before));
    const today = (await ds.query(`SELECT CURRENT_DATE::text AS d`))[0].d;
    await upsert('RULE_TIERED_LOAN_PENALTY_ACTIVATION_DATE', today, 'string');
    await upsert('RULE_TIERED_LOAN_PENALTY_ENABLED', 'true', 'boolean');
    const after = await ds.query(`SELECT key, value, "dataType", "isActive" FROM system_configs WHERE key LIKE 'RULE_TIERED%' ORDER BY key`);
    console.log('after:', JSON.stringify(after));
    await ds.destroy();
}
main().catch((e) => { console.error('ERR', e.message); process.exit(1); });
