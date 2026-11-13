'use strict';
// Exact decimal arithmetic on BigInt "units" (scale 10). Money never goes through floating point.
const SCALE = 10;
const ONE = 10n ** BigInt(SCALE);

/** Parse a decimal string/number (plain or exponent form) to BigInt units. Throws if precision would be lost. */
function parse(value) {
  if (value === null || value === undefined || value === '') return 0n;
  let s = String(value).trim().replace(/^\+/, '');
  if (/e/i.test(s)) s = expandExponent(s);
  const m = /^(-?)(\d*)(?:\.(\d*))?$/.exec(s);
  if (!m) throw new Error(`dec.parse: not a decimal: ${JSON.stringify(value)}`);
  const frac = (m[3] || '');
  const used = frac.slice(0, SCALE).padEnd(SCALE, '0');
  if (/[1-9]/.test(frac.slice(SCALE))) throw new Error(`dec.parse: more than ${SCALE} decimals: ${s}`);
  const units = BigInt((m[2] || '0') + used);
  return m[1] === '-' ? -units : units;
}

function expandExponent(s) {
  const m = /^(-?)(\d*)(?:\.(\d*))?e([+-]?\d+)$/i.exec(s);
  if (!m) throw new Error(`dec.expandExponent: ${s}`);
  const exp = Number(m[4]);
  let digits = (m[2] || '') + (m[3] || '');
  let pointPos = (m[2] || '').length + exp;
  if (pointPos <= 0) { digits = '0'.repeat(1 - pointPos) + digits; pointPos = 1; }
  if (pointPos > digits.length) digits = digits.padEnd(pointPos, '0');
  const intPart = digits.slice(0, pointPos) || '0';
  const fracPart = digits.slice(pointPos);
  return `${m[1]}${intPart}${fracPart ? '.' + fracPart : ''}`;
}

/** Canonical text: no exponent, no trailing zeros, no "+", "-0" -> "0". */
function normalize(value) {
  if (value === null || value === undefined) return null;
  return format(parse(value));
}

function format(units, decimals) {
  const neg = units < 0n;
  let abs = neg ? -units : units;
  const int = abs / ONE;
  let frac = String(abs % ONE).padStart(SCALE, '0');
  if (decimals === undefined) frac = frac.replace(/0+$/, '');
  else frac = frac.slice(0, decimals).padEnd(decimals, '0');
  const body = frac ? `${int}.${frac}` : String(int);
  return neg && (int !== 0n || /[1-9]/.test(frac)) ? '-' + body : body;
}

const add = (a, b) => parse(a) + parse(b);
const sum = list => list.reduce((acc, v) => acc + parse(v), 0n);
const abs = u => (u < 0n ? -u : u);
const eq = (a, b) => parse(a) === parse(b);
/** |a-b| <= tolerance (all decimal strings/numbers) */
const within = (a, b, tolerance) => abs(parse(a) - parse(b)) <= parse(tolerance);

module.exports = { SCALE, ONE, parse, normalize, format, add, sum, abs, eq, within };
