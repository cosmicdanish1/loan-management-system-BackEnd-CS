'use strict';

// Read-only, aggregate-only checks; no member names, credentials or raw rows exported.
const fs = require('node:fs');
const path = require('node:path');
const { Client } = require('pg');
const { sourceQuery, targetConfig, msQuote: mq, pgQuote: pq, OUT } = require('./inspect');

async function profile() {
  const r = JSON.parse(fs.readFileSync(path.join(OUT,'schema-comparison.json'),'utf8'));
  const pg = new Client(targetConfig());
  const result = { generatedAt:new Date().toISOString(), inventoryAt:r.generatedAt, note:'Live aggregates, not a consistent cutover snapshot. No writes.', keys:[], conversions:[], extraColumns:[], totals:[] };
  await pg.connect();
  try {
    await pg.query("SET default_transaction_read_only=on; SET statement_timeout='120s'; SET lock_timeout='10s'");
    const candidates = {
      member_master:['mbno'], member_balances:['mbno'], fundsmaster:['mbno'],
      loan_master:['mbno','loantype','loancaseno'], loan_pending:['loancaseno','mbno'],
      ledger:['trans_no','trans_date'], transactions:['trans_no','trans_date'],
      headmaster:['code'], usermaster:['userid'], fdmaster:['mbno','account_number'],
    };
    for (const c of r.comparisons.filter(c=>c.source && c.target)) {
      const msTable=mq(c.source.schema)+'.'+mq(c.source.name), pgTable=pq(c.target.schema)+'.'+pq(c.target.name);
      const key=candidates[c.target.name];
      if(key && key.every(k=>c.matched.some(m=>m.target.name===k))) {
        const msCols=key.map(k=>mq(c.matched.find(m=>m.target.name===k).source.name));
        const pgCols=key.map(pq);
        const msNull=msCols.map(k=>k+' IS NULL').join(' OR '), pgNull=pgCols.map(k=>k+' IS NULL').join(' OR ');
        const sql=`SELECT CONVERT(varchar(30),(SELECT COUNT_BIG(*) FROM ${msTable} WHERE ${msNull})) AS null_key_rows,
          CONVERT(varchar(30),(SELECT COUNT_BIG(*) FROM (SELECT ${msCols.join(',')} FROM ${msTable} GROUP BY ${msCols.join(',')} HAVING COUNT_BIG(*)>1) d)) AS duplicate_key_groups FOR JSON PATH`;
        const targetSql=`SELECT (SELECT count(*)::text FROM ${pgTable} WHERE ${pgNull}) AS null_key_rows,
          (SELECT count(*)::text FROM (SELECT ${pgCols.join(',')} FROM ${pgTable} GROUP BY ${pgCols.join(',')} HAVING count(*)>1) d) AS duplicate_key_groups`;
        result.keys.push({table:c.target.name,columns:key,source:sourceQuery(sql)[0],target:(await pg.query(targetSql)).rows[0]});
      }
      for(const m of c.matched.filter(m=>m.target.type==='numeric' && ['nvarchar','varchar','float','real'].includes(m.source.type))) {
        const col=mq(m.source.name), p=m.target.precision ?? 38,s=m.target.scale ?? 10;
        // Legacy compatibility level 100 supports TRY_CAST, not TRY_CONVERT.
        // Unbounded PostgreSQL numeric is conservatively probed as decimal(38,10).
        const cast=`TRY_CAST(${col} AS decimal(${p},${s}))`;
        const textType=['nvarchar','varchar'].includes(m.source.type);
        const metrics=[`COUNT_BIG(*) AS total_rows`,`COUNT_BIG(${col}) AS nonnull_rows`,
          `SUM(CASE WHEN ${col} IS NOT NULL AND ${cast} IS NULL THEN CONVERT(bigint,1) ELSE 0 END) AS failed_cast_rows`];
        if(textType) {
          metrics.push(`SUM(CASE WHEN ${col} IS NOT NULL AND LEN(LTRIM(RTRIM(${col})))=0 THEN CONVERT(bigint,1) ELSE 0 END) AS blank_rows`);
          metrics.push(`SUM(CASE WHEN ${col} LIKE '%,%' THEN CONVERT(bigint,1) ELSE 0 END) AS comma_rows`);
        } else {
          metrics.push(`SUM(CASE WHEN ${col}<>CONVERT(float,${cast}) THEN CONVERT(bigint,1) ELSE 0 END) AS rounded_rows`);
        }
        result.conversions.push({table:c.target.name,column:m.target.name,from:m.source.type,to:m.target.precision===null?'numeric (unbounded)':`numeric(${p},${s})`,probe:`decimal(${p},${s}); diagnostic only, not a conversion approval`,...sourceQuery(`SELECT ${metrics.join(',')} FROM ${msTable} FOR JSON PATH, INCLUDE_NULL_VALUES`)[0]});
      }
      if(c.targetOnly.length) {
        const expressions=c.targetOnly.map((col,i)=>`count(${pq(col.name)})::text AS ${pq('c'+i)}`);
        const counts=(await pg.query(`SELECT ${expressions.join(',')} FROM ${pgTable}`)).rows[0];
        result.extraColumns.push({table:c.target.name,columns:c.targetOnly.map((col,i)=>({name:col.name,nonNullRows:counts['c'+i]}))});
      }
      const sums={ledger:['trans_amt'],loan_master:['loan_amt','balance','instal_amt'],fundsmaster:['mdamt','cdamt','shareamt'],member_balances:['shares','compulsory_deposit','rd_amt'],transactions:['trans_amt']};
      if(sums[c.target.name]) {
        const cols=sums[c.target.name].filter(k=>c.matched.some(m=>m.target.name===k));
        const sourceExpr=cols.map(k=>`CONVERT(varchar(100),SUM(CONVERT(decimal(38,4),${mq(c.matched.find(m=>m.target.name===k).source.name)}))) AS ${mq(k)}`);
        const targetExpr=cols.map(k=>`sum(${pq(k)}::numeric)::text AS ${pq(k)}`);
        result.totals.push({table:c.target.name,source:sourceQuery(`SELECT ${sourceExpr.join(',')} FROM ${msTable} FOR JSON PATH, INCLUDE_NULL_VALUES`)[0],target:(await pg.query(`SELECT ${targetExpr.join(',')} FROM ${pgTable}`)).rows[0],note:'Totals describe different populations; they are not expected to reconcile before migration. Float source totals use decimal(38,4).'});
      }
    }
    // Core application relations are largely not protected by database FKs.
    result.relationships = {
      source:sourceQuery(`SELECT
        (SELECT COUNT_BIG(*) FROM dbo.LOAN_MASTER l WHERE NOT EXISTS (SELECT 1 FROM dbo.member_master m WHERE m.MBNO=l.MBNO)) AS loans_without_member,
        (SELECT COUNT_BIG(*) FROM (SELECT LOANCASENO FROM dbo.LOAN_MASTER GROUP BY LOANCASENO HAVING COUNT_BIG(*)>1) d) AS repeated_loan_case_groups,
        (SELECT COUNT_BIG(*) FROM dbo.LEDGER l WHERE l.MBNO IS NOT NULL AND l.MBNO<>0 AND NOT EXISTS (SELECT 1 FROM dbo.member_master m WHERE m.MBNO=l.MBNO)) AS ledger_rows_without_current_member
        FOR JSON PATH`)[0],
      target:(await pg.query(`SELECT
        (SELECT count(*) FROM loan_master l WHERE NOT EXISTS (SELECT 1 FROM member_master m WHERE m.mbno=l.mbno)) AS loans_without_member,
        (SELECT count(*) FROM (SELECT loancaseno FROM loan_master GROUP BY loancaseno HAVING count(*)>1) d) AS repeated_loan_case_groups,
        (SELECT count(*) FROM loan_repayment_ledger r WHERE NOT EXISTS (SELECT 1 FROM loan_master l WHERE l.loancaseno::text=r.loancaseno::text)) AS repayments_without_loan`)).rows[0],
    };
    fs.writeFileSync(path.join(OUT,'data-profile.json'),JSON.stringify(result,null,2));
    console.log(JSON.stringify(result,null,2));
    return result;
  } finally { await pg.end(); }
}

if(require.main===module) profile().catch(e=>{console.error(e.message);process.exitCode=1;});
module.exports={profile};
