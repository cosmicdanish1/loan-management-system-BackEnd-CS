const fs=require('fs');const {Client}=require('pg');const {targetConfig}=require('./inspect');
(async()=>{const c=new Client(targetConfig());await c.connect();
const leg=fs.readFileSync('scripts/legacy-migration/reports/legacy-loan-members.txt','utf8').split(/\r?\n/).filter(Boolean);
const have=new Set((await c.query('select distinct trim(mbno::text) m from loan_master')).rows.map(r=>r.m));
const inMaster=new Set((await c.query('select distinct trim(mbno::text) m from member_master')).rows.map(r=>r.m));
const miss=leg.filter(m=>!have.has(m));
const reset=new Set(['reset-demand-only-members.txt','reset-first-due-pilot-30.txt','reset-others-clean-members.txt','reset-refix-all-members.txt','sample50-members.txt'].flatMap(f=>fs.readFileSync('scripts/legacy-migration/reports/'+f,'utf8').split(/\r?\n/).filter(Boolean)));
console.log('legacy loan members',leg.length,'missing in PG loan_master',miss.length,'of which in member_master',miss.filter(m=>inMaster.has(m)).length,'in my reset lists',miss.filter(m=>reset.has(m)).length);
console.log('sample missing',miss.slice(0,8).join(','));
fs.writeFileSync('scripts/legacy-migration/reports/missing-loan-members.txt',miss.join('\n')+'\n');
await c.end()})()
