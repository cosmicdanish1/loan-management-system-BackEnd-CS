import { Injectable, BadRequestException, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import * as crypto from 'crypto';
import { LicenseKey, LicenseStatus } from './entities/license-key.entity';
import { ActivateLicenseDto, GenerateLicenseDto, LicenseStatusResponse } from './dto/license.dto';

// Secret used to sign/verify keys — keep this private
const LICENSE_SECRET = process.env.LICENSE_SECRET || 'PWT_LMS_SECRET_2025';

// License duration constants
const LICENSE_DURATION_DAYS = 365;   // 1 year
const GRACE_PERIOD_DAYS = 30;        // 1 month buffer

@Injectable()
export class LicenseService {
  constructor(
    @InjectRepository(LicenseKey)
    private readonly licenseRepo: Repository<LicenseKey>,
  ) {}

  /**
   * Generate a new license key for a customer.
   * Format: XXXX-XXXX-XXXX-XXXX (16 hex chars + dashes)
   */
  async generateKey(dto: GenerateLicenseDto): Promise<LicenseKey> {
    const rawKey = this.createKeyString();
    const license = this.licenseRepo.create({
      key: rawKey,
      customer_name: dto.customer_name,
      notes: dto.notes,
      status: LicenseStatus.PENDING,
    });
    return this.licenseRepo.save(license);
  }

  /**
   * Activate a license key on this machine.
   */
  async activate(dto: ActivateLicenseDto): Promise<LicenseStatusResponse> {
    const license = await this.licenseRepo.findOne({ where: { key: dto.key } });

    if (!license) {
      throw new NotFoundException('Invalid license key. Please check and try again.');
    }

    if (license.status === LicenseStatus.REVOKED) {
      throw new BadRequestException('This license key has been revoked.');
    }

    if (license.status === LicenseStatus.ACTIVE || license.status === LicenseStatus.EXPIRED) {
      // Already activated — just return current status
      return this.buildStatusResponse(license);
    }

    // Activate it
    const now = new Date();
    const expiresAt = new Date(now);
    expiresAt.setDate(expiresAt.getDate() + LICENSE_DURATION_DAYS);

    const graceEndsAt = new Date(expiresAt);
    graceEndsAt.setDate(graceEndsAt.getDate() + GRACE_PERIOD_DAYS);

    license.status = LicenseStatus.ACTIVE;
    license.activated_at = now;
    license.expires_at = expiresAt;
    license.grace_ends_at = graceEndsAt;
    license.machine_id = dto.machine_id || null;

    await this.licenseRepo.save(license);
    return this.buildStatusResponse(license);
  }

  /**
   * Check current license status.
   */
  async getStatus(): Promise<LicenseStatusResponse> {
    // Get the most recently activated license
    const license = await this.licenseRepo.findOne({
      where: [
        { status: LicenseStatus.ACTIVE },
        { status: LicenseStatus.EXPIRED },
      ],
      order: { activated_at: 'DESC' },
    });

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

  /**
   * Build a status response and update DB status if needed.
   */
  private async buildStatusResponse(license: LicenseKey): Promise<LicenseStatusResponse> {
    const now = new Date();
    const expiresAt = license.expires_at;
    const graceEndsAt = license.grace_ends_at;

    const msPerDay = 1000 * 60 * 60 * 24;
    const daysToExpiry = expiresAt ? Math.ceil((expiresAt.getTime() - now.getTime()) / msPerDay) : 0;
    const daysToGraceEnd = graceEndsAt ? Math.ceil((graceEndsAt.getTime() - now.getTime()) / msPerDay) : 0;

    let status: LicenseStatusResponse['status'];
    let message: string;

    if (now < expiresAt!) {
      // Within license period
      status = 'active';
      message = daysToExpiry <= 30
        ? `License expires in ${daysToExpiry} days. Please renew soon.`
        : `License is active. Valid for ${daysToExpiry} more days.`;
    } else if (graceEndsAt && now < graceEndsAt) {
      // In grace period
      status = 'grace';
      message = `License expired. Grace period: ${daysToGraceEnd} days remaining. Please renew immediately.`;

      // Update DB status if not already marked
      if (license.status !== LicenseStatus.EXPIRED) {
        license.status = LicenseStatus.EXPIRED;
        await this.licenseRepo.save(license);
      }
    } else {
      // Fully expired
      status = 'expired';
      message = 'License has expired and grace period has ended. Software is locked.';

      if (license.status !== LicenseStatus.EXPIRED) {
        license.status = LicenseStatus.EXPIRED;
        await this.licenseRepo.save(license);
      }
    }

    return {
      status,
      days_remaining: Math.max(0, daysToExpiry),
      grace_days_remaining: Math.max(0, daysToGraceEnd),
      activated_at: license.activated_at,
      expires_at: license.expires_at,
      grace_ends_at: license.grace_ends_at,
      customer_name: license.customer_name,
      message,
    };
  }

  /**
   * Generate a signed key string in format XXXX-XXXX-XXXX-XXXX
   */
  private createKeyString(): string {
    const timestamp = Date.now().toString(36).toUpperCase();
    const random = crypto.randomBytes(6).toString('hex').toUpperCase();
    const combined = (timestamp + random).substring(0, 12);
    const hmac = crypto
      .createHmac('sha256', LICENSE_SECRET)
      .update(combined)
      .digest('hex')
      .substring(0, 4)
      .toUpperCase();

    const full = (combined + hmac).padEnd(16, '0');
    return `${full.slice(0, 4)}-${full.slice(4, 8)}-${full.slice(8, 12)}-${full.slice(12, 16)}`;
  }

  /**
   * List all license keys (admin use)
   */
  async listAll(): Promise<LicenseKey[]> {
    return this.licenseRepo.find({ order: { created_at: 'DESC' } });
  }

  /**
   * Revoke a license key
   */
  async revoke(key: string): Promise<void> {
    const license = await this.licenseRepo.findOne({ where: { key } });
    if (!license) throw new NotFoundException('License key not found');
    license.status = LicenseStatus.REVOKED;
    await this.licenseRepo.save(license);
  }
}
