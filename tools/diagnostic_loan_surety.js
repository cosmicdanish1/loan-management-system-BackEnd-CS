const { Client } = require('pg');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../.env') });

/**
 * Diagnostic & Seeding Script for Loan Surety
 * 
 * Usage:
 * node diagnostic_loan_surety.js --check   (Check database state)
 * node diagnostic_loan_surety.js --seed    (Populate test data)
 */

const config = {
    host: process.env.DB_HOST || 'localhost',
    port: parseInt(process.env.DB_PORT) || 5432,
    user: process.env.DB_USERNAME || 'postgres',
    password: process.env.DB_PASSWORD || 'postgres',
    database: process.env.DB_DATABASE || 'loan_management_db',
};

// Use numeric IDs that work with the schema
const TEST_MBNO = 999999;
const TEST_CASE_NO = 888888;
const TEST_SURETY1 = 777777;
const TEST_SURETY2 = 666666;

async function run() {
    const client = new Client(config);
    const args = process.argv.slice(2);
    const mode = args.includes('--seed') ? 'seed' : 'check';

    try {
        await client.connect();
        console.log(`Connected to database: ${config.database}`);

        if (mode === 'check') {
            await checkDatabase(client);
        } else {
            await seedDatabase(client);
        }

    } catch (err) {
        console.error('Error:', err.message);
    } finally {
        await client.end();
    }
}

async function checkDatabase(client) {
    const tables = ['loan_pending', 'suretymaster', 'loan_master', 'member_master'];

    console.log('\n--- DATABASE STATS ---');
    for (const table of tables) {
        try {
            const res = await client.query(`SELECT COUNT(*) FROM ${table}`);
            console.log(`Table ${table.padEnd(15)}: ${res.rows[0].count} records`);
        } catch (e) {
            console.log(`Table ${table.padEnd(15)}: ❌ NOT FOUND or ERROR: ${e.message}`);
        }
    }

    // Check for our test case
    console.log(`\n--- SEARCHING FOR TEST CASE ${TEST_CASE_NO} ---`);
    const testCase = await client.query(`SELECT * FROM loan_pending WHERE loancaseno = $1`, [TEST_CASE_NO]);
    if (testCase.rows.length > 0) {
        console.log(`✅ Found TEST CASE ${TEST_CASE_NO}:`);
        console.log(JSON.stringify(testCase.rows[0], null, 2));
    } else {
        console.log(`❌ TEST CASE ${TEST_CASE_NO} not found.`);
    }
}

async function seedDatabase(client) {
    console.log('\n--- SEEDING TEST DATA ---');

    try {
        // 1. Ensure sample members exist
        const seedMembers = [
            [TEST_MBNO, 'TEST MEM'],
            [TEST_SURETY1, 'SURETY 1'],
            [TEST_SURETY2, 'SURETY 2']
        ];

        for (const [mbno, name] of seedMembers) {
            const check = await client.query('SELECT mbno FROM member_master WHERE mbno = $1', [mbno]);
            if (check.rows.length === 0) {
                await client.query(
                    `INSERT INTO member_master (mbno, f_name, isactive, officeno) 
                     VALUES ($1, $2, '1', 1)`,
                    [mbno, name]
                );
                console.log(`✅ Member ${mbno} (${name}) created.`);
            } else {
                await client.query(
                    `UPDATE member_master SET f_name = $1, isactive = '1' WHERE mbno = $2`,
                    [name, mbno]
                );
                console.log(`✅ Member ${mbno} (${name}) updated.`);
            }
        }

        // 2. Ensure test loan case exists (populating required numeric fields with 0/reasonable values)
        const checkLoan = await client.query('SELECT loancaseno FROM loan_pending WHERE loancaseno = $1', [TEST_CASE_NO]);
        if (checkLoan.rows.length === 0) {
            await client.query(
                `INSERT INTO loan_pending (loancaseno, mbno, g1mbno, g2mbno, loantype, no_of_instal, applied_amt, sanctioned_amt) 
                 VALUES ($1, $2, $3, $4, 'P.LOAN', 12, 50000, 50000)`,
                [TEST_CASE_NO, TEST_MBNO, TEST_SURETY1, TEST_SURETY2]
            );
            console.log(`✅ Loan case ${TEST_CASE_NO} created for member ${TEST_MBNO}.`);
        } else {
            await client.query(
                `UPDATE loan_pending SET g1mbno = $1, g2mbno = $2 WHERE loancaseno = $3`,
                [TEST_SURETY1, TEST_SURETY2, TEST_CASE_NO]
            );
            console.log(`✅ Loan case ${TEST_CASE_NO} updated.`);
        }

        console.log('\n--- SEEDING COMPLETE ---');
        console.log(`Use Case No: ${TEST_CASE_NO} in Change Loan Surety screen for testing.`);

    } catch (err) {
        console.error('Seeding Error:', err.message);
        throw err;
    }
}

run();
