'use strict';

// Read-only member-scoped audit used before any destructive migration step.
const fs = require('node:fs');
const path = require('node:path');
const { Client } = require('pg');
const { sourceQuery, targetConfig, msQuote, pgQuote, OUT } = require('./inspect');

const MEMBERS = [
  '610033194','610033050','30031087','610032800','610032486',
  '610031860','610032042','610032481','990041805','610031786',
  '940029511','610032763','610031698','610030060','610029800',
];
const memberSetSql = MEMBERS.join(',');

function memberColumns(columns) {
  return columns.filter(c => /mbno|memberid|member_id|memberno|member_no/i.test(c.name));
}

async function audit() {
  const inventory = JSON.parse(fs.readFileSync(path.join(OUT, 'schema-comparison.json'), 'utf8'));
  const pg = new Client(targetConfig());
  const report = {
    generatedAt: new Date().toISOString(),
    members: MEMBERS,
    note: 'Read-only live observations; no database rows changed.',
    source: { references: [], memberMaster: [], loans: [], pendingLoans: [], balances: [], ledgerByCode: [] },
    target: { references: [], memberMaster: [], loans: [], pendingLoans: [], balances: [], ledgerByCode: [] },
  };
  await pg.connect();
  try {
    await pg.query("SET default_transaction_read_only=on; SET statement_timeout='120s'; SET lock_timeout='10s'");

    // Operational migration scope: canonical dbo tables that also exist in the
    // target. Historical copies (_TABLE, TABLE_, dated snapshots, temp tables)
    // are evidence for reconciliation, not rows to load into the live app.
    const targetNames = new Set(inventory.target.tables.map(t=>t.name.toLowerCase()));
    const sourceMemberColumns = memberColumns(inventory.source.columns).filter(
      c => c.schema === 'dbo' && targetNames.has(c.table.toLowerCase()),
    );
    for (const [index,c] of sourceMemberColumns.entries()) {
      const table = `${msQuote(c.schema)}.${msQuote(c.table)}`;
      const col = msQuote(c.name);
      const rows = sourceQuery(`SELECT CONVERT(varchar(30),TRY_CAST(${col} AS bigint)) AS member, COUNT_BIG(*) AS rows
        FROM ${table} WHERE TRY_CAST(${col} AS bigint) IN (${memberSetSql})
        GROUP BY TRY_CAST(${col} AS bigint) ORDER BY TRY_CAST(${col} AS bigint) FOR JSON PATH`);
      if (rows.length) report.source.references.push({ schema:c.schema, table:c.table, column:c.name, matches:rows });
      if ((index+1)%20===0) console.log(`Source reference tables checked: ${index+1}/${sourceMemberColumns.length}`);
    }

    for (const c of memberColumns(inventory.target.columns)) {
      const table = `${pgQuote(c.schema)}.${pgQuote(c.table)}`;
      const col = pgQuote(c.name);
      const rows = (await pg.query(`SELECT trim(${col}::text) AS member, count(*)::text AS rows
        FROM ${table} WHERE trim(${col}::text) = ANY($1::text[])
        GROUP BY trim(${col}::text) ORDER BY trim(${col}::text)`, [MEMBERS])).rows;
      if (rows.length) report.target.references.push({ schema:c.schema, table:c.table, column:c.name, matches:rows });
    }

    report.source.memberMaster = sourceQuery(`SELECT CONVERT(varchar(30),MBNO) AS mbno,
      LTRIM(RTRIM(CONCAT(ISNULL(F_NAME,''),' ',ISNULL(M_NAME,''),' ',ISNULL(L_NAME,'')))) AS name,
      IsActive AS active, CONVERT(varchar(30),MEMB_DATE,23) AS member_date
      FROM dbo.member_master WHERE MBNO IN (${memberSetSql}) ORDER BY MBNO FOR JSON PATH, INCLUDE_NULL_VALUES`);
    report.source.loans = sourceQuery(`SELECT CONVERT(varchar(30),MBNO) AS mbno,LOANTYPE AS loan_type,
      CONVERT(varchar(30),LOANCASENO) AS loan_case,CONVERT(varchar(50),LOAN_AMT) AS loan_amount,
      CONVERT(varchar(50),BALANCE) AS balance,CONVERT(varchar(30),PAYMENT_DATE,23) AS payment_date,
      CONVERT(varchar(30),NO_OF_INSTAL) AS installments,CONVERT(varchar(50),INSTAL_AMT) AS installment_amount,
      CONVERT(varchar(50),RATE) AS rate FROM dbo.LOAN_MASTER WHERE MBNO IN (${memberSetSql})
      ORDER BY MBNO,LOANTYPE,LOANCASENO FOR JSON PATH, INCLUDE_NULL_VALUES`);
    report.source.pendingLoans = sourceQuery(`SELECT CONVERT(varchar(30),MBNO) AS mbno,LOANTYPE AS loan_type,
      CONVERT(varchar(30),LOANCASENO) AS loan_case,CONVERT(varchar(50),APPLIED_AMT) AS applied_amount,
      CONVERT(varchar(50),SANCTIONED_AMT) AS sanctioned_amount,CONVERT(varchar(30),APP_DATE,23) AS application_date,
      FLG_SANCTIONED AS sanctioned,FLG_PAID AS paid FROM dbo.LOAN_PENDING WHERE MBNO IN (${memberSetSql})
      ORDER BY MBNO,LOANTYPE,LOANCASENO FOR JSON PATH, INCLUDE_NULL_VALUES`);
    report.source.balances = sourceQuery(`SELECT CONVERT(varchar(30),MBNO) AS mbno,
      CONVERT(varchar(50),MDAMT) AS md_amount,CONVERT(varchar(50),CDAMT) AS cd_amount,
      CONVERT(varchar(50),SHAREAMT) AS share_amount FROM dbo.FUNDSMASTER WHERE MBNO IN (${memberSetSql})
      ORDER BY MBNO FOR JSON PATH, INCLUDE_NULL_VALUES`);
    report.source.ledgerByCode = sourceQuery(`SELECT CONVERT(varchar(30),MBNO) AS mbno,CODE AS code,ACC_TYPE AS account_type,
      COUNT_BIG(*) AS rows,CONVERT(varchar(50),SUM(CONVERT(decimal(38,4),TRANS_AMT))) AS amount
      FROM dbo.LEDGER WHERE MBNO IN (${memberSetSql}) GROUP BY MBNO,CODE,ACC_TYPE
      ORDER BY MBNO,CODE,ACC_TYPE FOR JSON PATH, INCLUDE_NULL_VALUES`);

    report.target.memberMaster = (await pg.query(`SELECT mbno::text AS mbno,
      trim(concat_ws(' ',f_name,m_name,l_name)) AS name,isactive AS active,memb_date::date::text AS member_date,
      remarks,full_name,email FROM member_master WHERE mbno::text = ANY($1::text[]) ORDER BY mbno`, [MEMBERS])).rows;
    report.target.loans = (await pg.query(`SELECT mbno::text AS mbno,loantype AS loan_type,loancaseno::text AS loan_case,
      loan_amt::text AS loan_amount,balance::text,payment_date::date::text,no_of_instal::text AS installments,
      instal_amt::text AS installment_amount,rate::text,delay_months::text,consolidated_into_loancaseno::text
      FROM loan_master WHERE mbno::text = ANY($1::text[]) ORDER BY mbno,loantype,loancaseno`, [MEMBERS])).rows;
    report.target.pendingLoans = (await pg.query(`SELECT mbno::text AS mbno,loantype AS loan_type,loancaseno::text AS loan_case,
      applied_amt::text AS applied_amount,sanctioned_amt::text AS sanctioned_amount,app_date::date::text AS application_date,
      flg_sanctioned AS sanctioned,flg_paid AS paid,pass_flag FROM loan_pending
      WHERE mbno::text = ANY($1::text[]) ORDER BY mbno,loantype,loancaseno`, [MEMBERS])).rows;
    report.target.balances = (await pg.query(`SELECT mbno::text AS mbno,mdamt::text AS md_amount,cdamt::text AS cd_amount,
      shareamt::text AS share_amount FROM fundsmaster WHERE mbno::text = ANY($1::text[]) ORDER BY mbno`, [MEMBERS])).rows;
    report.target.ledgerByCode = (await pg.query(`SELECT mbno::text AS mbno,code,acc_type AS account_type,
      count(*)::text AS rows,sum(trans_amt)::text AS amount FROM ledger WHERE mbno::text = ANY($1::text[])
      GROUP BY mbno,code,acc_type ORDER BY mbno,code,acc_type`, [MEMBERS])).rows;

    report.summary = {
      requested: MEMBERS.length,
      foundInSourceMemberMaster: new Set(report.source.memberMaster.map(x=>x.mbno)).size,
      foundInTargetMemberMaster: new Set(report.target.memberMaster.map(x=>x.mbno)).size,
      sourceReferences: report.source.references.reduce((n,x)=>n+x.matches.reduce((a,y)=>a+Number(y.rows),0),0),
      targetReferences: report.target.references.reduce((n,x)=>n+x.matches.reduce((a,y)=>a+Number(y.rows),0),0),
      sourceLoans: report.source.loans.length,
      targetLoans: report.target.loans.length,
      membersMissingFromSource: MEMBERS.filter(id=>!report.source.memberMaster.some(x=>x.mbno===id)),
      membersAlreadyInTarget: MEMBERS.filter(id=>report.target.memberMaster.some(x=>x.mbno===id)),
    };
    fs.mkdirSync(OUT,{recursive:true});
    fs.writeFileSync(path.join(OUT,'member-audit.json'),JSON.stringify(report,null,2));
    console.log(JSON.stringify(report.summary,null,2));
    return report;
  } finally { await pg.end(); }
}

if(require.main===module) audit().catch(e=>{console.error(e);process.exitCode=1;});
module.exports={audit,MEMBERS};
