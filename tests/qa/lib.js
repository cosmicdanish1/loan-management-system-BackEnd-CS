// Shared helpers for the black-box API QA suite (tests/qa).
// Usage: node tests/qa/<suite>.js   (backend must be running; see QA_BASE / QA_USER / QA_PASS)
const fs = require('fs');
const path = require('path');

const BASE = process.env.QA_BASE || 'http://localhost:3001/api/v1';
const ROOT = BASE.replace(/\/api\/v1$/, '');
const USER = process.env.QA_USER || 'admin';
const PASS = process.env.QA_PASS || 'SuperAdmin@2025';

async function http(method, url, { token, body, headers = {}, raw = false, timeout = 60000 } = {}) {
  const h = { ...headers };
  if (token) h.Authorization = `Bearer ${token}`;
  let payload;
  if (body !== undefined) {
    h['Content-Type'] = h['Content-Type'] || 'application/json';
    payload = typeof body === 'string' ? body : JSON.stringify(body);
  }
  const t0 = Date.now();
  try {
    const res = await fetch(url.startsWith('http') ? url : BASE + url, {
      method, headers: h, body: payload, signal: AbortSignal.timeout(timeout),
    });
    const text = await res.text();
    let json; try { json = JSON.parse(text); } catch { /* not json */ }
    return { status: res.status, ms: Date.now() - t0, json, text: raw ? text : text.slice(0, 600), headers: res.headers };
  } catch (e) {
    return { status: 0, ms: Date.now() - t0, error: e.name + ': ' + e.message };
  }
}

async function login(user = USER, pass = PASS) {
  const r = await http('POST', '/auth/login', { body: { username: user, password: pass } });
  const d = r.json && r.json.data;
  return { res: r, token: d && d.accessToken, refresh: d && d.refreshToken, user: d && d.user };
}

// Tiny test recorder: results are written to tests/qa/results/<suite>.json for the report/Excel step.
class Suite {
  constructor(name) { this.name = name; this.results = []; this.t0 = Date.now(); }
  check(id, title, ok, detail = '') {
    this.results.push({ id, title, ok: !!ok, detail: String(detail).slice(0, 400) });
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${id}  ${title}${ok ? '' : '  -> ' + String(detail).slice(0, 200)}`);
  }
  finish() {
    const dir = path.join(__dirname, 'results'); fs.mkdirSync(dir, { recursive: true });
    const failed = this.results.filter(r => !r.ok).length;
    fs.writeFileSync(path.join(dir, this.name + '.json'),
      JSON.stringify({ suite: this.name, ranAt: new Date().toISOString(), seconds: (Date.now() - this.t0) / 1000, total: this.results.length, failed, results: this.results }, null, 1));
    console.log(`\n${this.name}: ${this.results.length - failed}/${this.results.length} passed, ${failed} failed`);
    return failed;
  }
}

module.exports = { BASE, ROOT, USER, PASS, http, login, Suite };
