import {
  Controller,
  Post,
  Get,
  Body,
  Param,
  Delete,
  UseGuards,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { LicenseService } from './license.service';
import { ActivateLicenseDto, GenerateLicenseDto } from './dto/license.dto';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';

@Controller('license')
export class LicenseController {
  constructor(private readonly licenseService: LicenseService) {}

  /**
   * Public: Check current license status (called on every app boot)
   */
  @Get('status')
  @HttpCode(HttpStatus.OK)
  async getStatus() {
    const status = await this.licenseService.getStatus();
    return { success: true, data: status };
  }

  /**
   * Public: Activate a license key
   */
  @Post('activate')
  @HttpCode(HttpStatus.OK)
  async activate(@Body() dto: ActivateLicenseDto) {
    const result = await this.licenseService.activate(dto);
    return { success: true, data: result, message: 'License activated successfully' };
  }

  /**
   * Admin: Generate a new license key (requires auth)
   */
  @Post('generate')
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.CREATED)
  async generate(@Body() dto: GenerateLicenseDto) {
    const license = await this.licenseService.generateKey(dto);
    return { success: true, data: license, message: 'License key generated' };
  }

  /**
   * Admin: List all license keys (requires auth)
   */
  @Get('list')
  @UseGuards(JwtAuthGuard)
  async listAll() {
    const keys = await this.licenseService.listAll();
    return { success: true, data: keys };
  }

  /**
   * Admin: Revoke a license key (requires auth)
   */
  @Delete(':key/revoke')
  @UseGuards(JwtAuthGuard)
  async revoke(@Param('key') key: string) {
    await this.licenseService.revoke(key);
    return { success: true, message: 'License key revoked' };
  }
}
