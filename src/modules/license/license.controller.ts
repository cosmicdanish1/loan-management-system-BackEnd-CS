import {
  Controller,
  Post,
  Get,
  Body,
  HttpCode,
  HttpStatus,
  Logger,
  UseGuards,
} from '@nestjs/common';
import { LicenseService } from './license.service';
import { ActivateLicenseDto } from './dto/license.dto';
import { Public } from '../auth/decorators';
import { Roles } from '../auth/decorators/roles.decorator';
import { RoleGuard } from '../auth/guards/role.guard';
import { UserRole } from '../auth/entities/user.entity';

@Controller('license')
export class LicenseController {
  private readonly logger = new Logger(LicenseController.name);

  constructor(private readonly licenseService: LicenseService) {}

  /**
   * Public: Check current license status.
   * Result is cached in memory for the current calendar day —
   * safe to call on every app launch without hammering the DB.
   */
  @Public()
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
  @Public()
  @Post('activate')
  @HttpCode(HttpStatus.OK)
  async activate(@Body() dto: ActivateLicenseDto) {
    this.logger.log(`[License] Activation attempt for key=${dto.key?.slice(0, 8)}...`);
    const result = await this.licenseService.activate(dto);
    return { success: true, data: result, message: 'License activated successfully' };
  }

  /**
   * Admin: List all license records (for debugging).
   * ES-364: administrators only (it answered 200 to every signed-in role), and the key itself is masked: the
   * first block and the last 4 characters are enough to recognise a license, the rest of a working key must not
   * travel through the API.
   */
  @Get('list')
  @UseGuards(RoleGuard)
  @Roles(UserRole.ADMIN)
  async listAll() {
    const keys = await this.licenseService.listAll();
    const mask = (k: string) => (k && k.length > 10 ? `${k.slice(0, 9)}…${k.slice(-4)}` : k ? '****' : k);
    return { success: true, data: keys.map((row) => ({ ...row, key: mask(row.key) })) };
  }
}
