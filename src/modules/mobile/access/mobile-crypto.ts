import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as crypto from 'crypto';
import { resolveMemberSecret } from '../auth/member-secret';

export const sha256 = (v: string): string => crypto.createHash('sha256').update(v).digest('hex');

/** Unambiguous letters and digits (no 0/O, 1/I): easy to read out over a phone call. */
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

export function newActivationCode(length = 8): string {
  let out = '';
  for (let i = 0; i < length; i++) out += CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)];
  return out;
}

/** Accepts "abcd-efgh", "ABCD EFGH" and so on. */
export const normalizeCode = (c: string): string => String(c || '').toUpperCase().replace(/[\s-]/g, '');
export const formatCode = (c: string): string => (c.length === 8 ? `${c.slice(0, 4)}-${c.slice(4)}` : c);

const COMMON_WEAK = new Set(['000000', '111111', '123456', '654321', '121212', '123123', '112233', '010101', '159753', '123321', '696969']);

/**
 * Why an MPIN is too easy to guess, or null when it is acceptable. dob: the member's date of birth when known.
 * Rules (PRD 9.3): reject 123456, 000000, repeated digits, sequences, and anything built from the birth year or date.
 */
export function weakMpinReason(mpin: string, dob?: Date | string | null): string | null {
  if (!/^\d{6}$/.test(mpin || '')) return 'MPIN must be exactly 6 digits';
  if (COMMON_WEAK.has(mpin)) return 'This MPIN is too common. Choose something less obvious';
  if (/^(\d)\1{5}$/.test(mpin)) return 'MPIN cannot repeat the same digit';
  const d = [...mpin].map(Number);
  const diffs = d.slice(1).map((x, i) => x - d[i]);
  if (diffs.every((x) => x === 1) || diffs.every((x) => x === -1)) return 'MPIN cannot be a straight sequence';
  if (dob) {
    const dt = new Date(dob);
    if (!Number.isNaN(dt.getTime())) {
      const y = String(dt.getUTCFullYear());
      const dd = String(dt.getUTCDate()).padStart(2, '0');
      const mm = String(dt.getUTCMonth() + 1).padStart(2, '0');
      const yy = y.slice(2);
      if (mpin.startsWith(y) || mpin.endsWith(y)) return 'MPIN cannot contain your birth year';
      if ([dd + mm + yy, mm + dd + yy, yy + mm + dd].includes(mpin)) return 'MPIN cannot be your date of birth';
    }
  }
  return null;
}

/**
 * Hashing and encryption helpers whose keys come from JWT_MEMBER_SECRET (never stored in the database), so a leaked
 * database alone cannot be used to guess activation codes or read App Code secrets.
 */
@Injectable()
export class MobileCryptoService {
  private readonly secret: string;
  private readonly aesKey: Buffer;

  constructor(config: ConfigService) {
    this.secret = resolveMemberSecret(config);
    this.aesKey = Buffer.from(crypto.hkdfSync('sha256', this.secret, 'fibe-mobile', 'appcode-secret-v1', 32));
  }

  /** Keyed hash for activation codes and the answers of an activation request. */
  keyedHash(value: string): string {
    return crypto.createHmac('sha256', this.secret).update(value).digest('hex');
  }

  safeEqualHex(a: string, b: string): boolean {
    const x = Buffer.from(a, 'hex');
    const y = Buffer.from(b, 'hex');
    return x.length === y.length && crypto.timingSafeEqual(x, y);
  }

  /** AES-256-GCM: "iv.tag.ciphertext" in base64url. */
  encrypt(plain: string): string {
    const iv = crypto.randomBytes(12);
    const c = crypto.createCipheriv('aes-256-gcm', this.aesKey, iv);
    const enc = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
    return [iv, c.getAuthTag(), enc].map((b) => b.toString('base64url')).join('.');
  }

  decrypt(packed: string): string {
    const [iv, tag, enc] = packed.split('.').map((p) => Buffer.from(p, 'base64url'));
    const d = crypto.createDecipheriv('aes-256-gcm', this.aesKey, iv);
    d.setAuthTag(tag);
    return Buffer.concat([d.update(enc), d.final()]).toString('utf8');
  }

  newRefreshToken(): string {
    return crypto.randomBytes(48).toString('base64url');
  }
}
