// Copies the member signatures of the legacy system (Bank_Signature: ACCOUNT_NUMBER = member number, Signature = image)
// into the new database table bank_signature. The legacy database is only READ. Rows that already exist are left alone,
// so the script can be run again. Usage (from the backend folder):
//   node scripts/import-legacy-signatures.js            -> dry run, shows what would be copied
//   node scripts/import-legacy-signatures.js --apply    -> copies the missing rows
// Needs sqlcmd and Windows authentication to .\SQLEXPRESS (the same access the migration scripts use).
require('dotenv').config();
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Client } = require('pg');

const SERVER = process.env.LEGACY_SQL_SERVER || '.\\SQLEXPRESS';
const DB = process.env.LEGACY_SQL_DB || 'EMP_Espat_Society_dan';
const apply = process.argv.includes('--apply');

(async () => {
  const out = path.join(os.tmpdir(), 'legacy-signatures-' + Date.now() + '.txt');
  const sql = "SET NOCOUNT ON; SET TRANSACTION ISOLATION LEVEL READ UNCOMMITTED; " +
    "SELECT LTRIM(RTRIM(ACCOUNT_NUMBER)) + '|' + CONVERT(varchar(max), CAST(Signature AS varbinary(max)), 2) FROM Bank_Signature WHERE Signature IS NOT NULL";
  execFileSync('sqlcmd', ['-S', SERVER, '-E', '-d', DB, '-y', '0', '-Q', sql, '-o', out], { maxBuffer: 1 << 30 });
  const lines = fs.readFileSync(out, 'utf8').split(/\r?\n/).map((l) => l.trim()).filter((l) => /^[^|]+\|[0-9A-Fa-f]+$/.test(l));
  fs.unlinkSync(out);
  console.log(`legacy rows read: ${lines.length}`);

  const db = new Client({ host: process.env.DB_HOST, port: +process.env.DB_PORT, user: process.env.DB_USERNAME, password: process.env.DB_PASSWORD, database: process.env.DB_DATABASE });
  await db.connect();
  let added = 0, skipped = 0, bad = 0;
  for (const line of lines) {
    const [acc, hex] = line.split('|');
    const buf = Buffer.from(hex, 'hex');
    const isImage = (buf[0] === 0x42 && buf[1] === 0x4d) || (buf[0] === 0x89 && buf[1] === 0x50) || (buf[0] === 0xff && buf[1] === 0xd8);
    if (!isImage) { bad++; console.log('not an image, skipped:', acc); continue; }
    const have = await db.query('SELECT 1 FROM bank_signature WHERE btrim(account_number) = $1 LIMIT 1', [acc]);
    if (have.rowCount > 0) { skipped++; continue; }
    if (apply) await db.query('INSERT INTO bank_signature (account_number, signature) VALUES ($1, $2)', [acc, buf]);
    added++;
  }
  console.log(`${apply ? 'copied' : 'would copy'}: ${added}, already there: ${skipped}, not images: ${bad}`);
  await db.end();
})().catch((e) => { console.error(e); process.exit(1); });
