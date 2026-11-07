import { Controller, Get, Headers, Query, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Public } from '../../auth/decorators';
import { MobileThrottlerGuard } from '../security/mobile-throttler.guard';
import { MobileConfig, MobileStatus, MobileStatusService } from './mobile-status.service';

/**
 * Public routes the app calls before anyone is signed in. @Public() only switches off the STAFF login guard
 * (ES-216); these routes return no member data. Rate limited by IP.
 */
@ApiTags('Mobile')
@Public()
@UseGuards(MobileThrottlerGuard)
@Controller('mobile')
export class MobileStatusController {
  constructor(private readonly status: MobileStatusService) {}

  @Get('status')
  @ApiOperation({ summary: 'Server open/closed, maintenance, minimum app version, server time' })
  getStatus(): Promise<MobileStatus> {
    return this.status.getStatus();
  }

  @Get('config')
  @ApiOperation({ summary: 'Feature flags, Terms/Privacy versions and contacts' })
  getConfig(@Query('lang') lang?: string, @Headers('accept-language') acceptLanguage?: string): Promise<MobileConfig> {
    const fromHeader = (acceptLanguage || '').split(',')[0]?.split('-')[0];
    return this.status.getConfig(lang || fromHeader || 'en');
  }
}
