'use strict';

// Read-only. For every legacy member, compares per-table row counts already
// present in the target DB against what legacy holds for that member. Used
// to decide whether a delete-then-reload migration is safe, or whether some
// members already have target-only (post-launch, new-app) activity that a
// destructive reload would erase.
const fs = require('node:fs');
const path = require('node:path');
const { Client } = require('pg');
const { sourceQuery, targetConfig, msQuote, pgQuote, OUT } = require('./inspect');

const COPY_TABLES = [
  { source: 'BANK_CHEQ_MASTER', target: 'bank_cheq_master', member: 'MBNO' },
  { source: 'DEMAND_MASTER', target: 'demand_master', member: 'MBNO' },
  { source: 'DEMAND_MASTERDelete', target: 'demand_masterdelete', member: 'MBNO' },
  { source: 'FRS', target: 'frs', member: 'MBNO' },
  { source: 'FUNDSMASTER', target: 'fundsmaster', member: 'MBNO' },
  { source: 'LEDGER', target: 'ledger', member: 'MBNO' },
  { source: 'LEDGER_DATA', target: 'ledger_data', member: 'MBNO' },
  { source: 'LOAN_balance_history', target: 'loan_balance_history', member: 'mbno' },
  { source: 'LOAN_MASTER', target: 'loan_master', member: 'MBNO' },
  { source: 'LOAN_MASTERHISTORY', target: 'loan_masterhistory', member: 'MBNO' },
  { source: 'LOAN_PENDING', target: 'loan_pending', member: 'MBNO' },
  { source: 'LOAN_PRODUCT', target: 'loan_product', member: 'MBNo' },
  { source: 'Member_Balances', target: 'member_balances', member: 'MbNo' },
  { source: 'member_master', target: 'member_master', member: 'MBNO' },
  { source: 'MemberCategory', target: 'membercategory', member: 'MBNO' },
];

async function main() {
  const pg = new Client(targetConfig());
  await pg.connect();
  const report = { generatedAt: new Date().toISOString(), tables: [] };
  try {
    await pg.query("SET default_transaction_read_only=on; SET statement_timeout='120s'; SET lock_timeout='10s'");

    const legacyMembers = sourceQuery(
      `SELECT CONVERT(varchar(30),MBNO) AS member FROM dbo.member_master WHERE MBNO IS NOT NULL FOR JSON PATH`,
    ).map(r => r.member);
    const legacySet = new Set(legacyMembers);
    report.legacyMemberCount = legacySet.size;
    console.log(`Legacy member_master members: ${legacySet.size}`);

    for (const spec of COPY_TABLES) {
      const srcCounts = new Map(
        sourceQuery(
          `SELECT CONVERT(varchar(30),TRY_CAST(${msQuote(spec.member)} AS bigint)) AS member, COUNT_BIG(*) AS n
           FROM ${msQuote('dbo')}.${msQuote(spec.source)}
           WHERE TRY_CAST(${msQuote(spec.member)} AS bigint) IS NOT NULL
           GROUP BY TRY_CAST(${msQuote(spec.member)} AS bigint) FOR JSON PATH`,
        ).map(r => [r.member, Number(r.n)]),
      );

      let targetCol;
      try {
        targetCol = (
          await pg.query(
            `SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name=$1 AND lower(column_name)=lower($2)`,
            [spec.target, spec.member],
          )
        ).rows[0]?.column_name;
      } catch (e) { /* ignore */ }
      if (!targetCol) { report.tables.push({ table: spec.target, skipped: 'target table/column not found' }); continue; }

      const tgtRows = (
        await pg.query(
          `SELECT trim(${pgQuote(targetCol)}::text) AS member, count(*)::int AS n FROM ${pgQuote(spec.target)} GROUP BY 1`,
        )
      ).rows;
      const tgtCounts = new Map(tgtRows.map(r => [r.member, r.n]));

      const extraTargetOnlyMembers = []; // in target, not a legacy member at all
      const targetExceedsSource = [];    // legacy member, but target already has MORE rows than legacy holds
      const targetHasSomeAlready = [];   // legacy member, target has rows, <= source (likely prior migration or partial)

      for (const [member, tCount] of tgtCounts) {
        if (!legacySet.has(member)) { extraTargetOnlyMembers.push({ member, targetRows: tCount }); continue; }
        const sCount = srcCounts.get(member) || 0;
        if (tCount > sCount) targetExceedsSource.push({ member, sourceRows: sCount, targetRows: tCount });
        else if (tCount > 0) targetHasSomeAlready.push({ member, sourceRows: sCount, targetRows: tCount });
      }

      report.tables.push({
        table: spec.target,
        sourceMembersWithRows: srcCounts.size,
        targetMembersWithRows: tgtCounts.size,
        extraTargetOnlyMemberCount: extraTargetOnlyMembers.length,
        extraTargetOnlyMembersSample: extraTargetOnlyMembers.slice(0, 20),
        targetExceedsSourceCount: targetExceedsSource.length,
        targetExceedsSourceSample: targetExceedsSource.slice(0, 20),
        targetHasSomeAlreadyCount: targetHasSomeAlready.length,
      });
      console.log(
        `${spec.target}: target-only-members=${extraTargetOnlyMembers.length} legacy-members-where-target>source=${targetExceedsSource.length} legacy-members-with-existing-target-rows=${targetHasSomeAlready.length}`,
      );
    }

    fs.mkdirSync(OUT, { recursive: true });
    fs.writeFileSync(path.join(OUT, 'collision-audit.json'), JSON.stringify(report, null, 2));
    console.log('Wrote reports/collision-audit.json');
  } finally {
    await pg.end();
  }
}

if (require.main === module) main().catch(e => { console.error(e.stack || e.message); process.exitCode = 1; });
module.exports = { main };
