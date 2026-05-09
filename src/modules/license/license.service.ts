import { Injectable, BadRequestException, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import * as crypto from 'crypto';
import { LicenseKey, LicenseStatus } from './entities/license-key.entity';
import { ActivateLicenseDto, LicenseStatusResponse } from './dto/license.dto';

// Must match generate-license.js
const LICENSE_SECRET = process.env.LICENSE_SECRET || 'PWT_LMS_SECRET_KEY_2025_CHANGE_IN_PROD';
const GRACE_PERIOD_DAYS = 30;

// ── In-memory daily cache ──────────────────────────────────────────────────
// Status is checked once per calendar day, not on every window open.
interface CachedStatus {
  date: string;           // 'YYYY-MM-DD' — the day this was computed
  result: LicenseStatusResponse;
}
let statusCache: CachedStatus | null = null;

function todayStr(): string {
  return new Date().toISOString().slice(0, 10);
}

// ── Key format: PWT0-CCCC-DDDD-SSSS-SSSS ──────────────────────────────────
// CCCC = customer code (4 chars)
// DDDD = expiry days since epoch in base36 (4 chars)
// SSSS-SSSS = HMAC signature (8 hex chars split into two groups of 4)

function parseAndVerifyKey(key: string): { customerCode: string; expiryDate: Date } | null {
  // Normalise: uppercase, trim
  const k = key.trim().toUpperCase();
  const parts = k.split('-');

  // Expect exactly 5 parts: PWT0, CCCC, DDDD, SSSS, SSSS
  if (parts.length !== 5 || parts[0] !== 'PWT0') return null;

  const [, customerCode, expiryEncoded, sig1, sig2] = parts;
  if (!customerCode || !expiryEncoded || !sig1 || !sig2) return null;

  const payload = `${customerCode}${expiryEncoded}`;
  const expectedSig = crypto
    .createHmac('sha256', LICENSE_SECRET)
    .update(payload)
    .digest('hex')
    .toUpperCase()
    .slice(0, 8);

  const providedSig = `${sig1}${sig2}`;
  if (providedSig !== expectedSig) return null;

  // Decode expiry
  const expiryDays = parseInt(expiryEncoded, 36);
  if (isNaN(expiryDays)) return null;

  const expiryDate = new Date(expiryDays * 24 * 60 * 60 * 1000);
  return { customerCode, expiryDate };
}

@Injectable()
export class LicenseService {
  private readonly logger = new Logger(LicenseService.name);

  constructor(
    @InjectRepository(LicenseKey)
    private readonly licenseRepo: Repository<LicenseKey>,
  ) {}

  /**
   * Activate a self-validating license key.
   * - Verifies HMAC signature (no DB pre-insert needed)
   * - Replaces any existing active license
   * - Saves activation record to DB
   */
  async activate(dto: ActivateLicenseDto): Promise<LicenseStatusResponse> {
    const parsed = parseAndVerifyKey(dto.key);
    if (!parsed) {
      throw new BadRequestException('Invalid license key. Please check and try again.');
    }

    const { customerCode, expiryDate } = parsed;
    const now = new Date();

    if (expiryDate < now) {
      throw new BadRequestException('This license key has already expired.');
    }

    const graceEndsAt = new Date(expiryDate);
    graceEndsAt.setDate(graceEndsAt.getDate() + GRACE_PERIOD_DAYS);

    // Revoke all existing licenses first
    await this.licenseRepo
      .createQueryBuilder()
      .update()
      .set({ status: LicenseStatus.REVOKED })
      .where('status IN (:...statuses)', { statuses: [LicenseStatus.ACTIVE, LicenseStatus.EXPIRED, LicenseStatus.PENDING] })
      .execute();

    // Check if this exact key already exists (re-activation of same key)
    const normalizedKey = dto.key.trim().toUpperCase();
    const existing = await this.licenseRepo.findOne({ where: { key: normalizedKey } });

    let license: LicenseKey;
    if (existing) {
      // Re-activate the existing record
      existing.status = LicenseStatus.ACTIVE;
      existing.activated_at = now;
      existing.expires_at = expiryDate;
      existing.grace_ends_at = graceEndsAt;
      existing.machine_id = dto.machine_id ?? null;
      existing.notes = 'Self-validated key (re-activated)';
      license = await this.licenseRepo.save(existing);
    } else {
      // Insert new activation record
      const newLicense = this.licenseRepo.create({
        key: normalizedKey,
        customer_name: customerCode,
        status: LicenseStatus.ACTIVE,
        activated_at: now,
        expires_at: expiryDate,
        grace_ends_at: graceEndsAt,
        machine_id: dto.machine_id ?? null,
        notes: 'Self-validated key',
      });
      license = await this.licenseRepo.save(newLicense);
    }

    this.logger.log(`[License] Activated for customer=${customerCode} expires=${expiryDate.toISOString().slice(0, 10)}`);

    // Bust the daily cache so next getStatus() reflects the new activation
    statusCache = null;

    return this.buildStatusResponse(license);
  }

  /**
   * Get current license status.
   * Result is cached for the current calendar day — not recomputed on every
   * window open. Cache is busted on activation or when the day rolls over.
   */
  async getStatus(): Promise<LicenseStatusResponse> {
    const today = todayStr();

    // Return cached result if it's still the same day
    if (statusCache && statusCache.date === today) {
      return statusCache.result;
    }

    // Compute fresh status
    const result = await this.computeStatus();

    // Cache it for the rest of today
    statusCache = { date: today, result };
    this.logger.log(`[License] Status computed for ${today}: ${result.status}`);

    return result;
  }

  private async computeStatus(): Promise<LicenseStatusResponse> {
    // Use query builder for reliable ordering with multiple status conditions
    const license = await this.licenseRepo
      .createQueryBuilder('l')
      .where('l.status IN (:...statuses)', {
        statuses: [LicenseStatus.ACTIVE, LicenseStatus.EXPIRED],
      })
      .orderBy('l.activated_at', 'DESC')
      .getOne();

    if (!license) {
      return {
        status: 'not_activated',
        days_remaining: 0,
        grace_days_remaining: 0,
        activated_at: null,
        expires_at: null,
        grace_ends_at: null,
        customer_name: null,
        message: 'Software is not activated. Please enter your license key.',
      };
    }

    return this.buildStatusResponse(license);
  }

  private async buildStatusResponse(license: LicenseKey): Promise<LicenseStatusResponse> {
    const now = new Date();
    const expiresAt = license.expires_at!;
    const graceEndsAt = license.grace_ends_at!;

    const msPerDay = 1000 * 60 * 60 * 24;
    const daysToExpiry = Math.ceil((expiresAt.getTime() - now.getTime()) / msPerDay);
    const daysToGrace = Math.ceil((graceEndsAt.getTime() - now.getTime()) / msPerDay);

    let status: LicenseStatusResponse['status'];
    let message: string;

    if (now < expiresAt) {
      status = 'active';
      message = daysToExpiry <= 30
        ? `License expires in ${daysToExpiry} days. Please renew soon.`
        : `License is active. Valid for ${daysToExpiry} more days.`;
    } else if (now < graceEndsAt) {
      status = 'grace';
      message = `License expired. Grace period: ${Math.max(0, daysToGrace)} days remaining. Please renew.`;
      if (license.status !== LicenseStatus.EXPIRED) {
        license.status = LicenseStatus.EXPIRED;
        await this.licenseRepo.save(license);
      }
    } else {
      status = 'expired';
      message = 'License has expired. Software is locked. Please contact your administrator.';
      if (license.status !== LicenseStatus.EXPIRED) {
        license.status = LicenseStatus.EXPIRED;
        await this.licenseRepo.save(license);
      }
    }

    return {
      status,
      days_remaining: Math.max(0, daysToExpiry),
      grace_days_remaining: Math.max(0, daysToGrace),
      activated_at: license.activated_at,
      expires_at: license.expires_at,
      grace_ends_at: license.grace_ends_at,
      customer_name: license.customer_name,
      message,
    };
  }

  /** Admin: list all keys */
  async listAll(): Promise<LicenseKey[]> {
    return this.licenseRepo.find({ order: { created_at: 'DESC' } });
  }
}
