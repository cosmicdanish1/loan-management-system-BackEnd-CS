'use strict';
// Generic insert-only table copy: legacy (read-only, paged) -> Postgres (one open transaction), with a baseline
// per table: row count, sums of money columns, SHA-256 fingerprint. Nothing here deletes or updates.
const dec = require('./dec');
const canon = require('./canon');
const { mapColumns } = require('./colmap');
const { msQuote, selectExpr } = require('./legacy');
const { pgq } = require('./target');

const MAX_PARAMS = 60000;

// ------------------------------------------------------------------ legacy extraction
/** Async generator of row batches. Row keys are the TARGET column names, values are exact text (see selectExpr). */
function* legacyBatches(legacy, spec, columns /* mapColumns().shared */, batchSize) {
  const select = columns.map(c => selectExpr(c.source, c.name)).join(',');
  const table = msQuote('dbo') + '.' + msQuote(spec.legacy);
  const n = batchSize || spec.batch || 20000;
  let last = null;
  const [mode, keyName] = String(spec.order).split(':');
  for (;;) {
    let sql;
    if (mode === 'key') {
      const k = msQuote(keyName);
      const where = last === null ? '' : `WHERE ${k} > ${assertNumeric(last)}`;
      sql = `SELECT TOP (${n}) ${select} FROM ${table} ${where} ORDER BY ${k}`;
    } else {
      const where = last === null ? '' : `WHERE %%physloc%% > CONVERT(binary(8), ${assertHex(last)}, 1)`;
      sql = `SELECT TOP (${n}) ${select}, CONVERT(varchar(20), %%physloc%%, 1) AS [__pl] FROM ${table} ${where} ORDER BY %%physloc%%`;
    }
    const rows = legacy.rows(sql);
    if (!rows.length) return;
    if (mode === 'key') {
      const keyCol = columns.find(c => c.source.name.toLowerCase() === keyName.toLowerCase());
      last = rows[rows.length - 1][keyCol.name];
    } else {
      last = rows[rows.length - 1].__pl;
      for (const r of rows) delete r.__pl;
    }
    yield rows;
    if (rows.length < n) return;
  }
}
const assertNumeric = v => { if (!/^-?\d+(\.\d+)?$/.test(String(v))) throw new Error('bad key value ' + v); return String(v); };
const assertHex = v => { if (!/^0x[0-9A-Fa-f]{16}$/.test(String(v))) throw new Error('bad physloc ' + v); return `'${v}'`; };

// ------------------------------------------------------------------ baseline (legacy side only)
/** Count + sums by SQL on the legacy table. */
function legacySums(legacy, spec) {
  const parts = ['CONVERT(varchar(30),COUNT_BIG(*)) AS n', ...(spec.sums || []).map((c, i) => `CONVERT(varchar(60),SUM(CAST(${msQuote(c)} AS decimal(38,6)))) AS s${i}`)];
  const r = legacy.rows(`SELECT ${parts.join(',')} FROM ${msQuote('dbo')}.${msQuote(spec.legacy)}`)[0];
  return { rows: Number(r.n), sums: Object.fromEntries((spec.sums || []).map((c, i) => [c, dec.normalize(r['s' + i] ?? '0')])) };
}

/** Full legacy baseline of one table: rows, sums and the raw SHA-256 (mssql kinds). Streams the whole table. */
function legacyBaseline(legacy, spec, { onBatch } = {}) {
  const srcCols = legacy.columns(spec.legacy);
  if (!srcCols.length) throw new Error(`legacy table ${spec.legacy} not found`);
  const cols = srcCols.map(c => ({ source: c, name: c.name, kind: canon.kindOfMssql(c.type) }));
  const fp = new canon.MultisetFingerprint(); const oh = spec.orderedHash ? new canon.OrderedHash() : null;
  for (const batch of legacyBatches(legacy, spec, cols)) {
    for (const r of batch) { const c = canon.canonRow(r, cols); fp.add(c); if (oh) oh.add(c); }
    if (onBatch) onBatch(fp.count);
  }
  const sums = legacySums(legacy, spec);
  return { table: spec.id, rows: sums.rows, sums: sums.sums, streamedRows: fp.count, sha256: fp.hex(), orderedSha256: oh ? oh.hex() : undefined };
}

// ------------------------------------------------------------------ insert helpers
async function insertRows(target, table, columnNames, rows) {
  if (!rows.length) return 0;
  const per = Math.max(1, Math.floor(MAX_PARAMS / columnNames.length));
  for (let i = 0; i < rows.length; i += per) {
    const slice = rows.slice(i, i + per), values = [];
    const tuples = slice.map(r => '(' + columnNames.map(n => { values.push(r[n] === undefined ? null : r[n]); return '$' + values.length; }).join(',') + ')');
    await target.write(`INSERT INTO ${pgq(table)} (${columnNames.map(pgq).join(',')}) VALUES ${tuples.join(',')}`, values);
  }
  return rows.length;
}

// ------------------------------------------------------------------ the copy
/**
 * Copy one legacy table into the (empty) target table.
 * hooks: transform(row)->row (before insert; adds derived columns), expected(row)->row (image the target must
 * show after the DB's own triggers), extraColumns [{name, kind}] = target-only columns the hooks fill.
 * Returns the step record. With ctx.execute false nothing is written (a plan record is returned by planCopy).
 */
async function copyTable(ctx, spec, hooks = {}) {
  const { legacy, target } = ctx;
  const t0 = Date.now();
  const srcCols = legacy.columns(spec.legacy);
  if (!srcCols.length) throw new Error(`${spec.id}: legacy table ${spec.legacy} not found`);
  const tgtCols = await target.columns(spec.id);
  if (!tgtCols.length) throw new Error(`${spec.id}: target table does not exist (template incomplete)`);
  const map = mapColumns(srcCols, tgtCols);
  if (map.missingInTarget.length) throw new Error(`${spec.id}: SCHEMA DRIFT, legacy columns missing in the target: ${map.missingInTarget.join(', ')}`);
  const tgtByName = new Map(tgtCols.map(c => [c.name, c]));
  const extras = [];
  for (const [name] of Object.entries(spec.constants || {})) {
    if (tgtByName.has(name)) extras.push({ name, kind: canon.kindOfPg(tgtByName.get(name).data_type, tgtByName.get(name).udt_name), constant: spec.constants[name] });
    else ctx.report.add({ table: spec.id, section: spec.section, code: 'constant-column-absent', title: `target column ${name} does not exist in the template, default not applied`, severity: 'INFO' });
  }
  for (const e of hooks.extraColumns || []) {
    if (!tgtByName.has(e.name)) throw new Error(`${spec.id}: target column ${e.name} (derived) does not exist`);
    extras.push({ name: e.name, kind: canon.kindOfPg(tgtByName.get(e.name).data_type, tgtByName.get(e.name).udt_name) });
  }
  const insertNames = [...map.shared.map(c => c.name), ...extras.map(e => e.name)];
  const imageCols = [...map.shared.map(c => ({ name: c.name, kind: c.kind })), ...extras.map(e => ({ name: e.name, kind: e.kind }))];
  const rawCols = map.shared.map(c => ({ name: c.name, kind: canon.kindOfMssql(c.source.type) }));

  // existing target rows (insert-only; "missing" tables skip keys already present, e.g. I1013/I1014)
  const keyName = spec.insertMissingBy && spec.insertMissingBy[0];
  const existing = new Set();
  if (keyName) for (const r of await target.read(`SELECT ${pgq(keyName)}::text AS k FROM ${pgq(spec.id)}`)) existing.add(String(r.k).trim());
  else if (await target.hasRows(spec.id)) throw new Error(`${spec.id}: target is not empty and this table has no insert-missing key; refusing (no delete step exists)`);

  const rawFp = new canon.MultisetFingerprint(), rawOrdered = spec.orderedHash ? new canon.OrderedHash() : null;
  const expFp = new canon.MultisetFingerprint(), expOrdered = spec.orderedHash ? new canon.OrderedHash() : null;
  const expectedKeys = new Set();
  let inserted = 0, skipped = 0;
  for (const batch of legacyBatches(legacy, spec, map.shared)) {
    const toInsert = [];
    for (const raw of batch) {
      const rc = canon.canonRow(raw, rawCols); rawFp.add(rc); if (rawOrdered) rawOrdered.add(rc);
      let row = { ...raw };
      for (const e of extras) if (e.constant !== undefined) row[e.name] = e.constant;
      if (hooks.transform) row = hooks.transform(row, ctx);
      if (keyName) {
        const k = String(row[keyName.toLowerCase()] ?? row[keyName]).trim();
        expectedKeys.add(k);
        if (existing.has(k)) { skipped++; continue; }
      }
      toInsert.push(row);
      const image = hooks.expected ? hooks.expected(row, ctx) : row;
      const ic = canon.canonRow(image, imageCols); expFp.add(ic); if (expOrdered) expOrdered.add(ic);
    }
    inserted += await insertRows(target, spec.id, insertNames, toInsert);
  }

  // ---- verification against what is actually in the target
  const problems = [];
  const legacySum = legacySums(legacy, spec);
  if (rawFp.count !== legacySum.rows) problems.push(`legacy changed during the load: streamed ${rawFp.count} rows, COUNT says ${legacySum.rows}`);
  const base = ctx.baseline && ctx.baseline.get(spec.id);
  if (base) {
    if (base.rows !== rawFp.count) problems.push(`baseline rows ${base.rows} != streamed ${rawFp.count}`);
    if (base.sha256 !== rawFp.hex()) problems.push('baseline SHA-256 differs from the legacy data streamed now (legacy changed after the baseline)');
    for (const [c, v] of Object.entries(base.sums || {})) if (!dec.eq(v, legacySum.sums[c] ?? '0')) problems.push(`baseline sum ${c} ${v} != ${legacySum.sums[c]}`);
  }
  const selectCols = imageCols.map(c => pgq(c.name)).join(',');
  const order = spec.order.startsWith('key:') ? ` ORDER BY ${pgq(spec.order.split(':')[1].toLowerCase())}` : '';
  const tgtFp = new canon.MultisetFingerprint(), tgtOrdered = spec.orderedHash ? new canon.OrderedHash() : null;
  for await (const rows of target.cursor(`SELECT ${selectCols} FROM ${pgq(spec.id)}${order}`)) {
    for (const r of rows) {
      if (keyName && !expectedKeys.has(String(r[keyName.toLowerCase()]).trim())) continue; // seeded rows not from legacy
      if (keyName && existing.has(String(r[keyName.toLowerCase()]).trim())) continue;       // pre-existing rows are not ours to compare
      const c = canon.canonRow(r, imageCols); tgtFp.add(c); if (tgtOrdered) tgtOrdered.add(c);
    }
  }
  if (tgtFp.count !== expFp.count) problems.push(`row count: loaded ${tgtFp.count}, expected ${expFp.count}`);
  if (tgtFp.hex() !== expFp.hex()) problems.push('SHA-256 of the loaded rows differs from the legacy rows (row-by-row mismatch)');
  if (spec.orderedHash && tgtOrdered.hex() !== expOrdered.hex()) problems.push('ordered SHA-256 (LedgerId order) differs');
  const tgtSums = {};
  for (const c of spec.sums || []) {
    const tc = tgtByName.has(c.toLowerCase()) ? c.toLowerCase() : null;
    if (!tc) continue;
    const filter = keyName ? '' : '';
    tgtSums[c] = dec.normalize(await target.scalar(`SELECT coalesce(sum(${pgq(tc)}),0)::text FROM ${pgq(spec.id)}${filter}`) ?? '0');
    if (!keyName && !dec.eq(tgtSums[c], legacySum.sums[c])) problems.push(`sum of ${c}: loaded ${tgtSums[c]}, legacy ${legacySum.sums[c]}`);
  }
  if (problems.length) {
    const err = new Error(`${spec.id}: verification failed: ${problems.join(' | ')}`); err.problems = problems; throw err;
  }
  return {
    table: spec.id, section: spec.section, legacyRows: legacySum.rows, inserted, skippedExisting: skipped, sums: legacySum.sums,
    sha256: rawFp.hex(), loadedSha256: tgtFp.hex(), orderedSha256: rawOrdered ? rawOrdered.hex() : undefined,
    dumpReference: spec.dump, seconds: Math.round((Date.now() - t0) / 100) / 10,
  };
}

/** What a dry run prints for a copy table (no target needed). */
function planCopy(spec) {
  return `copy ${spec.legacy} -> ${spec.id} (section ${spec.section}; dump ${spec.dump} rows; ${spec.order.startsWith('key:') ? 'ordered by ' + spec.order.split(':')[1] : 'physical order'}; ` +
    `${spec.insertMissingBy ? 'insert missing by ' + spec.insertMissingBy[0] : 'insert only'}; checks: row count${spec.sums ? ', sums of ' + spec.sums.join('/') : ''}, SHA-256${spec.orderedHash ? ' (+ in LedgerId order)' : ''})`;
}

module.exports = { legacyBatches, legacyBaseline, legacySums, insertRows, copyTable, planCopy, MAX_PARAMS };
