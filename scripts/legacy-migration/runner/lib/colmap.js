'use strict';
const { kindOfPg } = require('./canon');

/**
 * Pair legacy columns with target columns by case-insensitive name.
 * sourceCols: [{ name, type }]   (sys.columns)   targetCols: [{ name, data_type, udt_name }] (information_schema)
 * Returns shared pairs (target names are used as row keys), legacy columns missing in the target (= schema
 * drift, blocks the run) and target-only columns (new-feature columns, left to constants/defaults).
 */
function mapColumns(sourceCols, targetCols, { rename = {} } = {}) {
  const targetByName = new Map(targetCols.map(c => [c.name.toLowerCase(), c]));
  const shared = [], missingInTarget = [];
  const used = new Set();
  for (const s of sourceCols) {
    const wanted = (rename[s.name] || rename[s.name.toLowerCase()] || s.name).toLowerCase();
    const t = targetByName.get(wanted);
    if (!t) { missingInTarget.push(s.name); continue; }
    used.add(wanted);
    shared.push({ source: s, target: t, name: t.name, kind: kindOfPg(t.data_type, t.udt_name) });
  }
  const targetOnly = targetCols.filter(c => !used.has(c.name.toLowerCase())).map(c => c.name);
  return { shared, missingInTarget, targetOnly };
}

module.exports = { mapColumns };
