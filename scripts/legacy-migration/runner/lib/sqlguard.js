'use strict';
// The runner may only READ the legacy database. Every statement sent to sqlcmd passes through this guard,
// and the Postgres side is split into a read-only connection (checks) and a writer that refuses to run
// unless --execute was given (see pgload.js).

const ALLOWED_SET = /^SET\s+(NOCOUNT\s+ON|LOCK_TIMEOUT\s+\d+|TRANSACTION\s+ISOLATION\s+LEVEL\s+(READ\s+UNCOMMITTED|READ\s+COMMITTED|SNAPSHOT)|ARITHABORT\s+ON)$/i;
const FORBIDDEN = /\b(INSERT|UPDATE|DELETE|MERGE|DROP|ALTER|CREATE|TRUNCATE|EXEC|EXECUTE|GRANT|REVOKE|DENY|INTO|BACKUP|RESTORE|SHUTDOWN|KILL|DBCC|BULK|OPENROWSET|OPENQUERY|OPENDATASOURCE|WAITFOR|USE|DECLARE|SP_\w+|XP_\w+)\b/i;

/** Remove string literals, bracketed identifiers and comments so keywords inside them are ignored. */
function stripLiterals(sql) {
  return sql
    .replace(/--[^\r\n]*/g, ' ')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/'(?:[^']|'')*'/g, "''")
    .replace(/\[(?:[^\]]|\]\])*\]/g, '[x]');
}

function assertReadOnlySql(sql) {
  const cleaned = stripLiterals(String(sql));
  const statements = cleaned.split(';').map(s => s.trim()).filter(Boolean);
  if (!statements.length) throw new Error('Refusing empty SQL');
  let sawSelect = false;
  for (const st of statements) {
    if (/^SET\b/i.test(st)) {
      if (!ALLOWED_SET.test(st)) throw new Error(`Refusing SET statement: ${st.slice(0, 60)}`);
      continue;
    }
    if (!/^(SELECT|WITH)\b/i.test(st)) throw new Error(`Refusing non-SELECT statement: ${st.slice(0, 60)}`);
    const bad = FORBIDDEN.exec(st);
    if (bad) throw new Error(`Refusing statement containing ${bad[1].toUpperCase()}: ${st.slice(0, 80)}`);
    sawSelect = true;
  }
  if (!sawSelect) throw new Error('Refusing SQL without a SELECT');
  return true;
}

/** Postgres statements used on the read-only (check) connection. */
function assertReadOnlyPg(sql) {
  const cleaned = String(sql).replace(/--[^\r\n]*/g, ' ').replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/'(?:[^']|'')*'/g, "''").replace(/"(?:[^"]|"")*"/g, '"x"').trim();
  const statements = cleaned.split(';').map(s => s.trim()).filter(Boolean);
  for (const st of statements) {
    if (!/^(SELECT|WITH|SHOW)\b/i.test(st)) throw new Error(`Read-only connection refuses: ${st.slice(0, 60)}`);
    if (/\b(INSERT|UPDATE|DELETE|DROP|ALTER|CREATE|TRUNCATE|GRANT|REVOKE|COPY|CALL|DO|LOCK|SET|NEXTVAL|SETVAL|PG_ADVISORY_LOCK|PG_TERMINATE_BACKEND)\b/i.test(st)) {
      throw new Error(`Read-only connection refuses: ${st.slice(0, 80)}`);
    }
  }
  return true;
}

module.exports = { assertReadOnlySql, assertReadOnlyPg, stripLiterals };
