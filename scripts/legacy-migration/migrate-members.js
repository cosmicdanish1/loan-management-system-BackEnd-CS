'use strict';

/**
 * Targeted SQL Server -> PostgreSQL member migration.
 *
 * Default: full transactional dry run (all inserts and verification, then rollback).
 * Commit:  node migrate-members.js --execute
 *
 * Source is always read-only. Execute mode creates a full pg_dump backup before
 * opening the target transaction. Credentials stay in backend/.env/db-config.json.
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { Client, types: pgTypes } = require('pg');
const dotenv = require('dotenv');
const { sourceQuery, targetConfig, msQuote, pgQuote, OUT } = require('./inspect');
const { MEMBERS } = require('./audit-members');

// Preserve timestamp-without-time-zone text exactly rather than applying the
// workstation timezone during verification.
pgTypes.setTypeParser(1114, value => value);
pgTypes.setTypeParser(1082, value => value);

const EXECUTE = process.argv.includes('--execute');
const BACKEND = path.resolve(__dirname, '../..');
const IDS_SQL = MEMBERS.join(',');
const BATCH_SIZE = 200;
const COPY_TABLES = [
  { source:'BANK_CHEQ_MASTER', target:'bank_cheq_master', member:'MBNO', expected:173 },
  { source:'DEMAND_MASTER', target:'demand_master', member:'MBNO', expected:1113 },
  { source:'DEMAND_MASTERDelete', target:'demand_masterdelete', member:'MBNO', expected:1796 },
  { source:'FRS', target:'frs', member:'MBNO', expected:13 },
  { source:'FUNDSMASTER', target:'fundsmaster', member:'MBNO', expected:15 },
  { source:'LEDGER', target:'ledger', member:'MBNO', expected:7584 },
  { source:'LEDGER_DATA', target:'ledger_data', member:'MBNO', expected:13 },
  { source:'LOAN_balance_history', target:'loan_balance_history', member:'mbno', expected:372 },
  { source:'LOAN_MASTER', target:'loan_master', member:'MBNO', expected:158 },
  { source:'LOAN_MASTERHISTORY', target:'loan_masterhistory', member:'MBNO', expected:144 },
  { source:'LOAN_PENDING', target:'loan_pending', member:'MBNO', expected:158 },
  { source:'LOAN_PRODUCT', target:'loan_product', member:'MBNo', expected:19 },
  { source:'Member_Balances', target:'member_balances', member:'MbNo', expected:13 },
  { source:'member_master', target:'member_master', member:'MBNO', expected:15 },
  { source:'MemberCategory', target:'membercategory', member:'MBNO', expected:15 },
];
// These are the only pre-existing member-scoped rows this script may replace.
// yearend_member is deliberately preserved because its 246 target rows have
// no current source counterpart; the other tables are deleted and reloaded.
const ALLOWED_PREEXISTING = new Set(['yearend_member', ...COPY_TABLES.map(t=>t.target)]);

function effectiveEnv() {
  const file = path.join(BACKEND,'.env');
  return { ...(fs.existsSync(file) ? dotenv.parse(fs.readFileSync(file)) : {}), ...process.env };
}

function backupTarget() {
  const env = effectiveEnv();
  const config = targetConfig();
  const exe = env.PG_DUMP_PATH || 'pg_dump';
  const stamp = new Date().toISOString().replace(/[:.]/g,'-');
  const dir = path.join(BACKEND,'backups');
  const destination = path.join(dir,`pre-member-migration-${stamp}.dump`);
  fs.mkdirSync(dir,{recursive:true});
  const result = spawnSync(exe,['-Fc','--no-owner','--no-acl','-h',config.host,'-p',String(config.port),'-U',config.user,'-d',config.database,'-f',destination],{
    encoding:'utf8',windowsHide:true,env:{...process.env,PGPASSWORD:config.password || ''},maxBuffer:8*1024*1024,
  });
  if(result.status!==0) throw new Error(`pg_dump failed: ${result.stderr || result.stdout}`);
  const bytes=fs.statSync(destination).size;
  if(bytes<1024) throw new Error(`Backup is unexpectedly small: ${destination} (${bytes} bytes)`);
  return {path:destination,bytes};
}

async function metadata(pg, spec) {
  const source = sourceQuery(`SELECT c.name,ty.name AS type,c.column_id AS ordinal
    FROM sys.tables t JOIN sys.columns c ON c.object_id=t.object_id
    JOIN sys.types ty ON ty.user_type_id=c.user_type_id WHERE t.name=N'${spec.source.replace(/'/g,"''")}'
    ORDER BY c.column_id FOR JSON PATH`);
  const target = (await pg.query(`SELECT column_name AS name,data_type AS type,udt_name,
    numeric_precision AS precision,numeric_scale AS scale,ordinal_position AS ordinal
    FROM information_schema.columns WHERE table_schema='public' AND table_name=$1 ORDER BY ordinal_position`,[spec.target])).rows;
  const targetMap=new Map(target.map(c=>[c.name.toLowerCase(),c]));
  const columns=source.map(s=>({source:s,target:targetMap.get(s.name.toLowerCase())})).filter(x=>x.target);
  if(!columns.length) throw new Error(`No shared columns for ${spec.source}`);
  if(columns.length!==source.length) throw new Error(`${spec.source}: source columns missing from target: ${source.filter(s=>!targetMap.has(s.name.toLowerCase())).map(s=>s.name).join(', ')}`);
  return columns;
}

function sourceExpression(column) {
  const c=msQuote(column.source.name), alias=msQuote(column.target.name);
  if(['numeric','decimal','money','smallmoney','bigint'].includes(column.source.type)) return `CONVERT(varchar(100),${c}) AS ${alias}`;
  if(['datetime','datetime2','smalldatetime','date','time'].includes(column.source.type)) return `CONVERT(varchar(40),${c},126) AS ${alias}`;
  return `${c} AS ${alias}`;
}

function extractRows(spec,columns) {
  const select=columns.map(sourceExpression).join(',');
  return sourceQuery(`SELECT ${select} FROM ${msQuote('dbo')}.${msQuote(spec.source)}
    WHERE TRY_CAST(${msQuote(spec.member)} AS bigint) IN (${IDS_SQL}) FOR JSON PATH, INCLUDE_NULL_VALUES`);
}

function converted(value,column) {
  if(value===null || value===undefined) return null;
  if(column.target.type==='bytea' && typeof value==='string') return Buffer.from(value,'base64');
  return value;
}

async function insertRows(pg,spec,columns,rows) {
  const names=columns.map(c=>c.target.name);
  for(let start=0;start<rows.length;start+=BATCH_SIZE) {
    const batch=rows.slice(start,start+BATCH_SIZE), values=[];
    const tuples=batch.map((row,rowIndex)=>'('+names.map((name,colIndex)=>{
      values.push(converted(row[name],columns[colIndex]));
      return '$'+values.length;
    }).join(',')+')');
    await pg.query(`INSERT INTO ${pgQuote(spec.target)} (${names.map(pgQuote).join(',')}) VALUES ${tuples.join(',')}`,values);
  }
}

function normalized(value,column) {
  if(value===null || value===undefined) return null;
  if(Buffer.isBuffer(value)) return value.toString('base64');
  const type=column.target.type;
  if(['numeric','decimal','smallint','integer','bigint'].includes(type)) {
    let s=String(value).trim().replace(/^\+/, '');
    if(/^-?\d+(\.\d+)?$/.test(s)) s=s.replace(/(\.\d*?)0+$/,'$1').replace(/\.$/,'');
    return s==='-0'?'0':s;
  }
  if(['real','double precision'].includes(type)) return Number(value);
  if(type==='timestamp without time zone' || type==='date') return String(value).replace(' ','T').replace(/\.0+$/,'');
  return value;
}

function fingerprint(rows,columns) {
  const records=rows.map(row=>columns.map(c=>normalized(row[c.target.name],c)));
  records.sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b)));
  return crypto.createHash('sha256').update(JSON.stringify(records)).digest('hex');
}

async function targetRows(pg,spec,columns) {
  const owner=columns.find(c=>c.source.name.toLowerCase()===spec.member.toLowerCase());
  if(!owner) throw new Error(`${spec.source}: member column is not shared`);
  return (await pg.query(`SELECT ${columns.map(c=>pgQuote(c.target.name)).join(',')} FROM ${pgQuote(spec.target)}
    WHERE trim(${pgQuote(owner.target.name)}::text)=ANY($1::text[])`,[MEMBERS])).rows;
}

async function currentTargetReferences(pg) {
  const refs=[];
  const columns=(await pg.query(`SELECT table_name,column_name FROM information_schema.columns
    WHERE table_schema='public' AND (lower(column_name)='mbno' OR (table_name='vouchers' AND column_name='memberId')) ORDER BY table_name`)).rows;
  for(const c of columns) {
    const rows=(await pg.query(`SELECT count(*)::int AS n FROM ${pgQuote(c.table_name)} WHERE trim(${pgQuote(c.column_name)}::text)=ANY($1::text[])`,[MEMBERS])).rows[0].n;
    if(rows) refs.push({table:c.table_name,column:c.column_name,rows});
  }
  const modern=(await pg.query(`SELECT count(*)::int AS n FROM members WHERE "memberNumber"=ANY($1::text[])`,[MEMBERS])).rows[0].n;
  if(modern) refs.push({table:'members',column:'memberNumber',rows:modern});
  return refs;
}

async function main() {
  const pg=new Client(targetConfig());
  let backup=null;
  if(EXECUTE) {
    console.log('Creating full PostgreSQL backup...');
    backup=backupTarget();
    console.log(`Backup verified: ${backup.path} (${backup.bytes} bytes)`);
  }
  await pg.connect();
  const report={startedAt:new Date().toISOString(),mode:EXECUTE?'execute':'dry-run',members:MEMBERS,backup,tables:[],preserved:[]};
  let began=false;
  try {
    const identity=(await pg.query('SELECT current_database() AS database,current_user AS username')).rows[0];
    if(identity.database!=='EMP_Espat_Society') throw new Error(`Refusing unexpected target ${identity.database}`);
    const refs=await currentTargetReferences(pg);
    const unexpected=refs.filter(r=>!ALLOWED_PREEXISTING.has(r.table));
    if(unexpected.length) throw new Error(`Unexpected target member records appeared after audit: ${JSON.stringify(unexpected)}`);
    report.preexisting=refs;
    report.preserved=refs.filter(r=>r.table==='yearend_member');
    await pg.query('BEGIN'); began=true;
    await pg.query("SET LOCAL lock_timeout='10s'; SET LOCAL statement_timeout='10min'");
    await pg.query("SELECT pg_advisory_xact_lock(hashtext('legacy-member-migration'))");

    for(const spec of COPY_TABLES) {
      const columns=await metadata(pg,spec);
      const sourceRows=extractRows(spec,columns);
      if(sourceRows.length!==spec.expected) {
        throw new Error(`${spec.source}: audited ${spec.expected} source rows but extraction returned ${sourceRows.length}; target was not deleted`);
      }
      const owner=columns.find(c=>c.source.name.toLowerCase()===spec.member.toLowerCase());
      const deleted=(await pg.query(`DELETE FROM ${pgQuote(spec.target)} WHERE trim(${pgQuote(owner.target.name)}::text)=ANY($1::text[])`,[MEMBERS])).rowCount;
      await insertRows(pg,spec,columns,sourceRows);
      const copied=await targetRows(pg,spec,columns);
      const sourceHash=fingerprint(sourceRows,columns),targetHash=fingerprint(copied,columns);
      if(copied.length!==sourceRows.length || sourceHash!==targetHash) throw new Error(`${spec.target}: verification failed source=${sourceRows.length}/${sourceHash} target=${copied.length}/${targetHash}`);
      report.tables.push({table:spec.target,deleted,inserted:sourceRows.length,sha256:sourceHash});
      console.log(`${spec.target}: deleted ${deleted}, inserted and verified ${sourceRows.length}`);
    }

    await pg.query(`UPDATE member_master SET full_name=trim(concat_ws(' ',f_name,m_name,l_name))
      WHERE mbno::text=ANY($1::text[])`,[MEMBERS]);
    const members=(await pg.query(`SELECT mbno::text AS mbno,trim(concat_ws(' ',f_name,m_name,l_name)) AS name,isactive
      FROM member_master WHERE mbno::text=ANY($1::text[]) ORDER BY mbno`,[MEMBERS])).rows;
    if(members.length!==MEMBERS.length) throw new Error(`Expected ${MEMBERS.length} member rows, found ${members.length}`);
    report.membersVerified=members;
    report.finishedAt=new Date().toISOString();
    fs.mkdirSync(OUT,{recursive:true});
    if(EXECUTE) {
      await pg.query('COMMIT'); began=false;
      fs.writeFileSync(path.join(OUT,'member-migration-result.json'),JSON.stringify(report,null,2));
      console.log(`COMMITTED ${report.tables.reduce((n,t)=>n+t.inserted,0)} source rows for ${MEMBERS.length} members.`);
    } else {
      await pg.query('ROLLBACK'); began=false;
      fs.writeFileSync(path.join(OUT,'member-migration-dry-run.json'),JSON.stringify(report,null,2));
      console.log(`DRY RUN PASSED and rolled back ${report.tables.reduce((n,t)=>n+t.inserted,0)} source rows.`);
    }
  } catch(error) {
    if(began) await pg.query('ROLLBACK').catch(()=>{});
    throw error;
  } finally { await pg.end(); }
}

if(require.main===module) main().catch(e=>{console.error(e.stack||e.message);process.exitCode=1;});
module.exports={main,COPY_TABLES};
