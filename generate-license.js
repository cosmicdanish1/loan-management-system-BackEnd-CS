#!/usr/bin/env node
/**
 * PWT License Key Generator
 * Run: node generate-license.js
 *
 * Prompts for: generator name, password, duration (months), company name.
 * Saves the generated key to the database.
 */

const crypto = require('crypto');
const path   = require('path');
const fs     = require('fs');

// ── Load .env ─────────────────────────────────────────────────────────────────
(function loadEnv() {
  const envPath = path.join(__dirname, '.env');
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const eq = t.indexOf('=');
    if (eq === -1) continue;
    const k = t.slice(0, eq).trim();
    const v = t.slice(eq + 1).trim();
    if (!process.env[k]) process.env[k] = v;
  }
})();

const LICENSE_SECRET  = process.env.LICENSE_SECRET || 'PWT_LMS_SECRET_KEY_2025_CHANGE_IN_PROD';
const GENERATION_PASS = '7692829866786687';
const GRACE_DAYS      = 30;

// ── Stdin line queue ──────────────────────────────────────────────────────────
// Buffers incoming lines so sequential prompt() calls never miss a line,
// even when stdin is piped and data arrives all at once.

const lineQueue   = [];
const lineWaiters = [];

process.stdin.setEncoding('utf8');
let stdinBuffer = '';

function stdinDataHandler(chunk) {
  stdinBuffer += chunk;
  let idx;
  while ((idx = stdinBuffer.indexOf('\n')) !== -1) {
    const line = stdinBuffer.slice(0, idx).replace(/\r$/, '').trim();
    stdinBuffer = stdinBuffer.slice(idx + 1);
    if (lineWaiters.length > 0) {
      lineWaiters.shift()(line);
    } else {
      lineQueue.push(line);
    }
  }
}

process.stdin.on('data', stdinDataHandler);

function readLine(label) {
  process.stdout.write(label);
  return new Promise(resolve => {
    if (lineQueue.length > 0) {
      process.nextTick(() => resolve(lineQueue.shift()));
    } else {
      lineWaiters.push(resolve);
    }
  });
}

// ── Password prompt (TTY only: masks with *) ──────────────────────────────────
function readPassword(label) {
  if (!process.stdin.isTTY) {
    return readLine(label);
  }

  return new Promise(resolve => {
    process.stdout.write(label);

    // Detach line-queue listener so raw keystrokes don't pollute the queue
    process.stdin.removeListener('data', stdinDataHandler);
    stdinBuffer = '';

    process.stdin.setRawMode(true);
    process.stdin.setEncoding('utf8');
    process.stdin.resume();

    let pwd = '';
    const onData = (ch) => {
      if (ch === '\r' || ch === '\n') {
        process.stdin.setRawMode(false);
        process.stdin.removeListener('data', onData);
        process.stdout.write('\n');
        // Re-attach line-queue listener for remaining prompts
        process.stdin.on('data', stdinDataHandler);
        resolve(pwd);
      } else if (ch === '') {    // Ctrl-C
        process.stdout.write('\n');
        process.exit(0);
      } else if (ch === '' || ch === '\b') {
        if (pwd.length > 0) {
          pwd = pwd.slice(0, -1);
          process.stdout.write('\b \b');
        }
      } else {
        pwd += ch;
        process.stdout.write('*');
      }
    };
    process.stdin.on('data', onData);
  });
}

// ── Key generation ────────────────────────────────────────────────────────────

function addMonths(date, months) {
  const d = new Date(date);
  d.setMonth(d.getMonth() + months);
  return d;
}

function generateKey(customerCode, expiryDate) {
  const expiryDays    = Math.floor(expiryDate.getTime() / (24 * 60 * 60 * 1000));
  const expiryEncoded = expiryDays.toString(36).toUpperCase().padStart(4, '0');
  const payload       = `${customerCode}${expiryEncoded}`;
  const sig           = crypto
    .createHmac('sha256', LICENSE_SECRET)
    .update(payload)
    .digest('hex')
    .toUpperCase()
    .slice(0, 8);
  return `PWT0-${customerCode}-${expiryEncoded}-${sig.slice(0, 4)}-${sig.slice(4, 8)}`;
}

// ── Display ───────────────────────────────────────────────────────────────────
function printBox(lines) {
  const width = Math.max(...lines.map(l => l.length)) + 4;
  const bar   = '═'.repeat(width - 2);
  console.log(`\n╔${bar}╗`);
  for (const l of lines) {
    console.log(`║  ${l.padEnd(width - 4)}  ║`);
  }
  console.log(`╚${bar}╝\n`);
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  console.log('\n┌──────────────────────────────────────┐');
  console.log('│   PWT Software License Key Generator │');
  console.log('└──────────────────────────────────────┘\n');

  // 1. Who is generating
  const generatedBy = await readLine('1. Your name (who is generating): ');
  if (!generatedBy) { console.error('Name is required.'); process.exit(1); }

  // 2. Generation password
  const password = await readPassword('2. Generation password: ');
  if (password !== GENERATION_PASS) {
    console.error('\n✗ Incorrect password. Access denied.');
    process.exit(1);
  }
  console.log('   ✓ Password verified.\n');

  // 3. Duration in months
  const monthsRaw = await readLine('3. License duration (months, e.g. 1 / 3 / 6 / 12): ');
  const months    = parseInt(monthsRaw, 10);
  if (isNaN(months) || months <= 0) {
    console.error('Duration must be a positive whole number of months.');
    process.exit(1);
  }

  // 4. Company name
  const companyName = await readLine('4. Company name: ');
  if (!companyName) { console.error('Company name is required.'); process.exit(1); }

  process.stdin.destroy();

  // ── Compute key ──────────────────────────────────────────────────────────
  const customerCode = companyName.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 4).padEnd(4, '0');
  const now          = new Date();
  const expiryDate   = addMonths(now, months);
  const graceEnds    = new Date(expiryDate.getTime() + GRACE_DAYS * 24 * 60 * 60 * 1000);
  const licenseKey   = generateKey(customerCode, expiryDate);

  // ── Save to DB ───────────────────────────────────────────────────────────
  process.stdout.write('Saving to database... ');

  const { Client } = require('pg');
  const client = new Client({
    host:     process.env.DB_HOST     || 'localhost',
    port:     parseInt(process.env.DB_PORT || '5432', 10),
    user:     process.env.DB_USERNAME || 'postgres',
    password: process.env.DB_PASSWORD,
    database: process.env.DB_DATABASE,
  });

  try {
    await client.connect();
    await client.query(
      `INSERT INTO license_keys
         (key, customer_name, company_name, generated_by, duration_months,
          status, expires_at, grace_ends_at, notes, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,'generated',$6,$7,$8,NOW(),NOW())
       ON CONFLICT (key) DO UPDATE SET
         company_name    = EXCLUDED.company_name,
         generated_by    = EXCLUDED.generated_by,
         duration_months = EXCLUDED.duration_months,
         notes           = EXCLUDED.notes,
         updated_at      = NOW()`,
      [
        licenseKey,
        customerCode,
        companyName,
        generatedBy,
        months,
        expiryDate,
        graceEnds,
        `Generated by ${generatedBy} for ${companyName} | ${months} month(s)`,
      ]
    );
    console.log('✓ Saved.\n');
  } catch (err) {
    console.log('✗ Failed.');
    console.error('Database error:', err.message);
    process.exit(1);
  } finally {
    await client.end();
  }

  // ── Show result ──────────────────────────────────────────────────────────
  printBox([
    'LICENSE KEY GENERATED SUCCESSFULLY',
    '',
    `Key:      ${licenseKey}`,
    `Company:  ${companyName}`,
    `Duration: ${months} month(s)`,
    `Expires:  ${expiryDate.toISOString().slice(0, 10)}`,
    `Grace:    ${graceEnds.toISOString().slice(0, 10)}  (+${GRACE_DAYS} days)`,
    `By:       ${generatedBy}`,
  ]);
}

main().catch(err => { console.error('\nError:', err.message); process.exit(1); });
