/*
 * Creates retained demo loans for the Demand Master frontend workflow.
 * This is deliberately additive: it never deletes or updates existing rows.
 * Run against the configured test database only.
 */
require('dotenv').config();

const fs = require('node:fs');
const path = require('node:path');
const { Client } = require('pg');

const DEMO_MARKER = process.env.DEMAND_DEMO_MARKER || 'DM-NOV-2027-DEMO';
const DEMO_YEAR = 2027;
const DEMO_MONTH = 11;
const outputDir = path.resolve(__dirname, '../../../test-data/demand-master');
const csvPath = path.join(outputDir, 'november-2027-demand.csv');
const manifestPath = path.join(outputDir, 'november-2027-manifest.json');

const dbConfig = {
  host: process.env.DB_HOST,
  port: process.env.DB_PORT,
  user: process.env.DB_USERNAME,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_DATABASE,
};

function csvCell(value) {
  const text = String(value ?? '');
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

async function main() {
  const db = new Client(dbConfig);
  await db.connect();
  try {
    const existing = (await db.query(
      `SELECT mbno::text AS "memberNo", loantype, loancaseno::text AS "caseNo",
              loan_amt, instal_amt, balance, purpose
       FROM loan_master WHERE purpose = $1 ORDER BY mbno`,
      [DEMO_MARKER],
    )).rows;

    let loans = existing;
    if (existing.length === 0) {
      // Prefer members with no active loan so Demand Generation represents
      // exactly the demo loan, not an unknown mix of legacy loans.
      const members = (await db.query(`
        SELECT mm.mbno::text AS "memberNo", mm.officeno::text AS "officeNo",
               TRIM(COALESCE(mm.f_name, '') || ' ' || COALESCE(mm.m_name, '') || ' ' || COALESCE(mm.l_name, '')) AS "memberName"
        FROM member_master mm
        WHERE COALESCE(mm.isactive, 'Y') <> 'N'
          AND NOT EXISTS (
            SELECT 1 FROM loan_master lm
            WHERE lm.mbno = mm.mbno AND COALESCE(lm.balance, 0) > 0
          )
        ORDER BY mm.mbno
        LIMIT 5`)).rows;
      if (members.length < 5) throw new Error(`Only ${members.length} inactive-loan members are available; need 5`);

      const installments = [1000, 1250, 1500, 1750, 2000];
      const amounts = [24000, 30000, 36000, 42000, 48000];
      await db.query('BEGIN');
      try {
        for (let i = 0; i < members.length; i += 1) {
          const member = members[i];
          const caseNo = String(970000 + i + 1);
          const result = await db.query(`
            INSERT INTO loan_master (
              mbno, loantype, loancaseno, loan_amt, payment_date, rate,
              no_of_instal, instal_amt, balance, openbalance, purpose,
              intt_amount, penalrate, loan_payment_model, loan_interest_method
            ) VALUES ($1, 'RLN', $2, $3, $4, 12, $5, $6, $3, $3, $7, 0, 0, 'SEPARATE_INTEREST', 'REDUCING_BALANCE')
            RETURNING mbno::text AS "memberNo", loantype, loancaseno::text AS "caseNo",
                      loan_amt, instal_amt, balance, purpose`,
            [member.memberNo, caseNo, amounts[i], '2027-10-01', 24, installments[i], DEMO_MARKER],
          );
          loans.push({ ...result.rows[0], memberName: member.memberName, officeNo: member.officeNo });
        }
        await db.query('COMMIT');
      } catch (error) {
        await db.query('ROLLBACK');
        throw error;
      }
    }

    const memberIds = loans.map((loan) => String(loan.memberNo));
    const details = (await db.query(`
      SELECT mm.mbno::text AS "memberNo", mm.officeno::text AS "officeNo",
             TRIM(COALESCE(mm.f_name, '') || ' ' || COALESCE(mm.m_name, '') || ' ' || COALESCE(mm.l_name, '')) AS "memberName",
             lm.loancaseno::text AS "caseNo", lm.loantype, lm.loan_amt, lm.instal_amt, lm.balance
      FROM loan_master lm JOIN member_master mm ON mm.mbno = lm.mbno
      WHERE lm.purpose = $1 ORDER BY lm.mbno`, [DEMO_MARKER])).rows;

    fs.mkdirSync(outputDir, { recursive: true });
    const header = ['S.NO.', 'YYMM', 'CODE', 'MS.NO.', 'PS.NO.', 'NAME', 'TOTAL', 'R/D', 'R/LOAN', 'E/LOAN', 'INTT'];
    const lines = [header.map(csvCell).join(',')];
    for (let i = 0; i < details.length; i += 1) {
      const loan = details[i];
      const installment = Number(loan.instal_amt);
      lines.push([
        i + 1, '2711', 'RLN', loan.memberNo, 'P', loan.memberName,
        installment.toFixed(2), '0.00', installment.toFixed(2), '0.00', '0.00',
      ].map(csvCell).join(','));
    }
    fs.writeFileSync(csvPath, `${lines.join('\n')}\n`, 'utf8');

    const manifest = {
      marker: DEMO_MARKER,
      database: dbConfig.database,
      period: { month: 'NOV', year: DEMO_YEAR, yymm: '2711' },
      branchNumbers: [...new Set(details.map((r) => r.officeNo))],
      members: details.map((r) => ({
        memberNo: r.memberNo,
        memberName: r.memberName,
        officeNo: r.officeNo,
        loanType: r.loantype,
        loanCaseNo: r.caseNo,
        loanAmount: Number(r.loan_amt),
        installment: Number(r.instal_amt),
        balance: Number(r.balance),
      })),
      csvPath,
      instructions: [
        'Open Demand Master > Generate Demand and select NOV 2027.',
        'Use the branch number listed above and member scope if the screen offers it.',
        'Alternatively use Import Demand List and upload the CSV path above.',
        'Do not use a different period unless you intentionally want separate demo data.',
      ],
    };
    fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

    console.log(JSON.stringify({
      createdOrExistingLoans: details.length,
      marker: DEMO_MARKER,
      csvPath,
      manifestPath,
      members: manifest.members,
    }, null, 2));
  } finally {
    await db.end();
  }
}

main().catch((error) => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
