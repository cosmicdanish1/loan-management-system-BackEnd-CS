#!/usr/bin/env node
/**
 * Break-glass: reset one user's two-factor authentication from the SERVER (ES-206).
 *
 * Use it ONLY when nobody can do it from the app, typically when the last administrator lost
 * their phone and has no recovery code. Everyone else is reset from
 * Administration > Security > Two-Factor & Approvals > Users > Reset.
 *
 *   npm run twofa:reset -- <username>
 *   npm run twofa:reset -- <username> --temp-password     (also sets a random temporary password, shown once)
 *   npm run twofa:reset -- <username> --yes               (skip the "type the username to confirm" question)
 *
 * It removes the user's authenticator and recovery codes, clears any lockout and remembered
 * computers, ends their current sessions, and writes an audit row ("break_glass_reset") that says
 * it was done from the server console. It cannot be run over the network: it needs access to the
 * server's .env (database login).
 */
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const readline = require('readline');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const { Client } = require('pg');

const args = process.argv.slice(2);
const username = args.find((a) => !a.startsWith('--'));
const yes = args.includes('--yes');
const wantTemp = args.includes('--temp-password');

function ask(q) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => rl.question(q, (a) => { rl.close(); resolve(a.trim()); }));
}

function tempPassword() {
  // 12 characters, always with an upper-case letter, a lower-case letter and a digit (the app's password rule).
  const lower = 'abcdefghijkmnpqrstuvwxyz', upper = 'ABCDEFGHJKLMNPQRSTUVWXYZ', digit = '23456789';
  const pick = (set) => set[crypto.randomInt(set.length)];
  const all = lower + upper + digit;
  const chars = [pick(lower), pick(upper), pick(digit)];
  while (chars.length < 12) chars.push(pick(all));
  for (let i = chars.length - 1; i > 0; i--) { const j = crypto.randomInt(i + 1); [chars[i], chars[j]] = [chars[j], chars[i]]; }
  return chars.join('');
}

(async () => {
  if (!username) {
    console.error('Usage: npm run twofa:reset -- <username> [--temp-password] [--yes]');
    process.exit(2);
  }
  const db = new Client({
    host: process.env.DB_HOST, port: process.env.DB_PORT, user: process.env.DB_USERNAME,
    password: process.env.DB_PASSWORD, database: process.env.DB_DATABASE,
  });
  await db.connect();
  try {
    const found = (await db.query(
      `SELECT u.userid, u.susername, u.totp_enabled, u.enable_disable, l.userlevel
         FROM usermaster u LEFT JOIN userlevelmaster l ON l.userlevelid = u.userlevelid
        WHERE lower(u.susername) = lower($1)`, [username])).rows;
    if (found.length === 0) { console.error(`No user named "${username}".`); process.exit(1); }
    if (found.length > 1) { console.error(`More than one user matches "${username}". Use the exact name.`); process.exit(1); }
    const u = found[0];

    console.log('');
    console.log(`User:    ${u.susername}  (${u.userlevel || 'no level'})`);
    console.log(`Account: ${u.enable_disable === 'E' ? 'enabled' : 'DISABLED'}`);
    console.log(`2FA:     ${u.totp_enabled ? 'set up' : 'not set up'}`);
    console.log(`Action:  remove the authenticator and recovery codes${wantTemp ? ', set a temporary password' : ''}, end their sessions.`);
    console.log('');
    if (!yes) {
      const typed = await ask(`Type the username (${u.susername}) to confirm: `);
      if (typed.toLowerCase() !== u.susername.toLowerCase()) { console.log('Not confirmed. Nothing was changed.'); process.exit(1); }
    }

    let temp = null;
    await db.query('BEGIN');
    await db.query(
      `UPDATE usermaster SET totp_secret_enc = NULL, totp_enabled = false, totp_last_step = NULL, totp_enrolled_at = NULL,
              totp_failed_count = 0, totp_locked_until = NULL, totp_verified_at = NULL, force_logout_at = now(), login_status = 'N'
        WHERE userid = $1`, [u.userid]);
    await db.query('DELETE FROM user_recovery_codes WHERE user_id = $1', [u.userid]);
    await db.query('DELETE FROM trusted_devices WHERE user_id = $1', [u.userid]);
    if (wantTemp) {
      const bcrypt = require('bcrypt');
      temp = tempPassword();
      await db.query('UPDATE usermaster SET spassword = $2 WHERE userid = $1', [u.userid, await bcrypt.hash(temp, 10)]);
    }
    await db.query(
      `INSERT INTO twofa_audit (user_id, actor, event, detail) VALUES ($1, 'server-console', 'break_glass_reset', $2)`,
      [u.userid, `run on ${os.hostname()} by OS user ${os.userInfo().username}${wantTemp ? '; temporary password set' : ''}`]);
    await db.query('COMMIT');

    console.log(`Done. ${u.susername} can now sign in without a code${wantTemp ? ' using the temporary password below' : ' with their usual password'}.`);
    if (temp) {
      console.log('');
      console.log(`  Temporary password (shown once): ${temp}`);
      console.log('  Give it to the person in private and ask them to change it straight away (Change Password).');
    }
    console.log('If two-factor is required for them, they will be asked to set up a new authenticator at sign-in.');
  } catch (e) {
    try { await db.query('ROLLBACK'); } catch { /* nothing to roll back */ }
    console.error('Failed, nothing was changed:', e.message);
    process.exitCode = 1;
  } finally {
    await db.end();
  }
})();
