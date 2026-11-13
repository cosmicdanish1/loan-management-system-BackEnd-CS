'use strict';
// Review report generator (step 15, 44.2): every "report only" line of every table section, grouped by table,
// plus the loaded numbers and the verification results. Pure: feed it entries, get JSON + Markdown + CSV text.

const SEVERITIES = ['BLOCKER', 'WARN', 'INFO'];

class ReviewReport {
  constructor(meta = {}) { this.meta = meta; this.entries = []; this.checks = []; this.steps = []; }

  /** A "report only" line: something the society should look at (never blocks the run, P1). */
  add({ table, section = '', code, title, count = null, samples = [], note = '', severity = 'WARN', expected = null }) {
    if (!SEVERITIES.includes(severity)) throw new Error(`bad severity ${severity}`);
    this.entries.push({ table, section, code, title, count, samples: samples.slice(0, 50), note, severity, expected });
    return this;
  }

  /** Verification result line (pass/fail). */
  check({ name, section = '', ok, detail = '', blocking = true }) {
    this.checks.push({ name, section, ok: !!ok, detail, blocking });
    return this;
  }

  step(rec) { this.steps.push(rec); return this; }

  get failedBlockingChecks() { return this.checks.filter(c => !c.ok && c.blocking); }

  toJSON() {
    return { meta: this.meta, summary: this.summary(), steps: this.steps, checks: this.checks, entries: this.entries };
  }

  summary() {
    const by = {};
    for (const e of this.entries) by[e.severity] = (by[e.severity] || 0) + 1;
    return { entries: this.entries.length, bySeverity: by, checks: this.checks.length, checksFailed: this.checks.filter(c => !c.ok).length, blockingFailed: this.failedBlockingChecks.length };
  }

  toMarkdown() {
    const out = [];
    const s = this.summary();
    out.push('# Migration review report', '');
    for (const [k, v] of Object.entries(this.meta)) out.push(`- **${k}:** ${v}`);
    out.push('', `Report lines: ${s.entries} (${Object.entries(s.bySeverity).map(([k, v]) => `${k} ${v}`).join(', ') || 'none'}). Verification checks: ${s.checks}, failed: ${s.checksFailed}, blocking failures: ${s.blockingFailed}.`, '');
    out.push('Nothing in the "report" sections was changed by the migration (principle P1): the society reviews and corrects these in the app.', '');
    if (this.steps.length) {
      out.push('## Load steps', '', '| Step | What | Result | Rows | Seconds |', '|---:|---|---|---:|---:|');
      for (const r of this.steps) out.push(`| ${r.no} | ${esc(r.title)} | ${esc(r.status)} | ${r.rows ?? ''} | ${r.seconds ?? ''} |`);
      out.push('');
    }
    if (this.checks.length) {
      out.push('## Verification suite', '', '| Check | Section | Result | Detail |', '|---|---|---|---|');
      for (const c of this.checks) out.push(`| ${esc(c.name)} | ${esc(c.section)} | ${c.ok ? 'PASS' : (c.blocking ? 'FAIL' : 'NOTE')} | ${esc(c.detail)} |`);
      out.push('');
    }
    const tables = [...new Set(this.entries.map(e => e.table))].sort();
    out.push('## Report lines by table', '');
    if (!tables.length) out.push('_No report lines._', '');
    for (const t of tables) {
      out.push(`### ${t}`, '');
      for (const e of this.entries.filter(x => x.table === t)) {
        const exp = e.expected !== null && e.expected !== undefined ? ` (dump reference: ${e.expected})` : '';
        out.push(`- **[${e.severity}] ${e.title}**${e.count !== null ? `: ${e.count}` : ''}${exp}${e.section ? ` (section ${e.section})` : ''}${e.note ? `. ${e.note}` : ''}`);
        if (e.samples.length) out.push(`  - e.g. ${e.samples.slice(0, 15).map(x => '`' + (typeof x === 'object' ? JSON.stringify(x) : x) + '`').join(', ')}${e.samples.length > 15 ? ', ...' : ''}`);
      }
      out.push('');
    }
    return out.join('\n');
  }

  /** One CSV with every sample of every line, for the society to open in Excel. */
  toCsv() {
    const lines = ['table,code,severity,sample'];
    for (const e of this.entries) for (const smp of e.samples) lines.push([e.table, e.code, e.severity, typeof smp === 'object' ? JSON.stringify(smp) : smp].map(csv).join(','));
    return lines.join('\n') + '\n';
  }
}

const esc = v => String(v ?? '').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
const csv = v => '"' + String(v ?? '').replace(/"/g, '""') + '"';

module.exports = { ReviewReport };
