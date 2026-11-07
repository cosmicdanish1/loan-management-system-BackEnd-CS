import * as crypto from 'crypto';

/**
 * License keys, format 2 (ES-393):  PWT1-<CCCC>-<DDDD>-<signature in groups>
 *   CCCC = customer code, DDDD = expiry day number in base36 (same as format 1)
 *   signature = Ed25519 signature of "PWT1|CCCC|DDDD", base32 (RFC 4648, no padding), split into groups of 8
 *
 * The backend only holds the PUBLIC key, which can check a key but can never make one. The private key stays with
 * whoever issues licenses (generate-license.js). Format 1 (PWT0, HMAC with a shared secret) is only accepted during
 * a announced overlap, see isLegacyAllowed().
 */

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function b32encode(buf: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

export function b32decode(text: string): Buffer | null {
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of text) {
    const idx = B32.indexOf(ch);
    if (idx === -1) return null;
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

// The public half of the license signing key. Public on purpose: it can only verify. LICENSE_PUBLIC_KEY (PEM) in .env
// replaces it, which is how the key pair is rotated without a new build.
const BUILT_IN_PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAF5Qefdk+grNEi6j088KQWMtCo8Rdm2ar7oKfIxFX7Uc=
-----END PUBLIC KEY-----`;

function publicKey(): crypto.KeyObject {
  const fromEnv = (process.env.LICENSE_PUBLIC_KEY || '').replace(/\\n/g, '\n').trim();
  return crypto.createPublicKey(fromEnv || BUILT_IN_PUBLIC_KEY);
}

export function v2Payload(customerCode: string, expiryEncoded: string): Buffer {
  return Buffer.from(`PWT1|${customerCode}|${expiryEncoded}`, 'utf8');
}

/** Checks a format 2 key. Returns its customer code and expiry day (base36), or null if it is not genuine. */
export function verifyV2Key(normalizedKey: string): { customerCode: string; expiryEncoded: string } | null {
  const parts = normalizedKey.split('-');
  if (parts.length < 4 || parts[0] !== 'PWT1') return null;
  const [, customerCode, expiryEncoded, ...sigGroups] = parts;
  if (!/^[A-Z0-9]{4}$/.test(customerCode) || !/^[A-Z0-9]{4}$/.test(expiryEncoded)) return null;
  const sig = b32decode(sigGroups.join(''));
  if (!sig || sig.length !== 64) return null;
  // the last base32 character carries padding bits; a key written with different padding bits is not the issued key
  if (b32encode(sig) !== sigGroups.join('')) return null;
  try {
    const ok = crypto.verify(null, v2Payload(customerCode, expiryEncoded), publicKey(), sig);
    return ok ? { customerCode, expiryEncoded } : null;
  } catch {
    return null;
  }
}

/** Format 1 (HMAC with a shared secret) is honoured only while LICENSE_LEGACY_UNTIL (YYYY-MM-DD) is in the future. */
export function isLegacyAllowed(now = new Date()): boolean {
  const until = (process.env.LICENSE_LEGACY_UNTIL || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(until)) return false;
  const end = new Date(`${until}T23:59:59Z`);
  return !isNaN(end.getTime()) && now.getTime() <= end.getTime();
}
