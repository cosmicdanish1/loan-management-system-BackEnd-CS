import {
  Controller,
  Post,
  Get,
  Body,
  HttpCode,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { LicenseService } from './license.service';
import { ActivateLicenseDto } from './dto/license.dto';

@Controller('license')
export class LicenseController {
  private readonly logger = new Logger(LicenseController.name);

  constructor(private readonly licenseService: LicenseService) {}

  /**
   * Public: Check current license status.
   * Result is cached in memory for the current calendar day —
   * safe to call on every app launch without hammering the DB.
   */
  @Get('status')
  @HttpCode(HttpStatus.OK)
  async getStatus() {
    const status = await this.licenseService.getStatus();
    return { success: true, data: status };
  }

  /**
   * Public: Activate a self-validating license key.
   * The key encodes customer + expiry + HMAC — no pre-insert needed.
   * Replaces any previously active license on this machine.
   */
  @Post('activate')
  @HttpCode(HttpStatus.OK)
  async activate(@Body() dto: ActivateLicenseDto) {
    this.logger.log(`[License] Activation attempt for key=${dto.key?.slice(0, 8)}...`);
    const result = await this.licenseService.activate(dto);
    return { success: true, data: result, message: 'License activated successfully' };
  }

  /**
   * Admin: List all license records (for debugging)
   */
  @Get('list')
  async listAll() {
    const keys = await this.licenseService.listAll();
    return { success: true, data: keys };
  }
}
