import { BadRequestException, Body, Controller, Get, HttpCode, HttpStatus, Param, ParseIntPipe, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { IsBoolean, IsIn, IsInt, IsOptional, IsString, Length, Matches, Max, MaxLength, Min } from 'class-validator';
import { BlocklistService } from '../security/blocklist.service';
import { MobileOpsService } from './mobile-ops.service';
import { CurrentUser } from '../../auth/decorators';
import { RequireMenuAction } from '../../auth/guards/menu-right.guard';
import { RequireAuthCode } from '../../auth/twofa/require-auth-code';
import { MobileAdminService } from './mobile-admin.service';

class BlockDto {
  @IsString() @Length(3, 300) reason: string;
}
class NoteDto {
  @IsOptional() @IsString() @MaxLength(500) note?: string;
}
class VerifyCodeDto {
  @IsString() @Matches(/^\d{6}$/, { message: 'code must be 6 digits' }) code: string;
}

class FlagDto {
  @IsBoolean() enabled: boolean;
}
class VersionDto {
  @IsString() @Matches(/^\d{1,4}\.\d{1,4}\.\d{1,4}$/, { message: 'latestVersion looks like 1.2.3' }) latestVersion: string;
  @IsString() @Matches(/^\d{1,4}\.\d{1,4}\.\d{1,4}$/, { message: 'minSupportedVersion looks like 1.2.3' }) minSupportedVersion: string;
  @IsOptional() @IsString() @MaxLength(300) storeUrl?: string;
  @IsOptional() @IsString() @MaxLength(300) message?: string;
}
class MaintenanceDto {
  @IsBoolean() enabled: boolean;
  @IsOptional() @IsString() @MaxLength(300) message?: string;
}
class AuditQuery {
  @IsOptional() @IsString() @MaxLength(18) mbno?: string;
  @IsOptional() @IsString() @MaxLength(60) event?: string;
  @IsOptional() @IsString() @MaxLength(20) result?: string;
  @IsOptional() @IsString() @MaxLength(64) ip?: string;
  @IsOptional() @IsString() @MaxLength(100) deviceId?: string;
  @IsOptional() @IsString() @MaxLength(10) from?: string;
  @IsOptional() @IsString() @MaxLength(10) to?: string;
  @IsOptional() @IsInt() @Min(1) @Max(200) limit?: number;
  @IsOptional() @IsInt() @Min(0) offset?: number;
}
class BlockTargetDto {
  @IsIn(['IP', 'DEVICE']) kind: 'IP' | 'DEVICE';
  @IsString() @Length(3, 100) value: string;
  @IsString() @Length(3, 300) reason: string;
}

const MBNO = new RegExp('^\\d{1,18}$');
const staffName = (u: any): string => String(u?.username ?? u?.id ?? 'staff');

/**
 * Staff API behind the Mobile Control Center window (desktop). Uses the normal STAFF login; the window right is
 * MOBILE_CONTROL_CENTER (Configure UserLevel Default Rights). Issuing a code, resetting an MPIN and blocking can ask for
 * an approver's authenticator code when switched on in Administration > Security > Two-Factor Authentication.
 * This controller is never published to the internet (the tunnel only allows /api/v1/mobile/*; this path is /admin/mobile).
 */
@ApiTags('Mobile Control Center')
@ApiBearerAuth()
@RequireMenuAction('MOBILE_CONTROL_CENTER')
@Controller('admin/mobile')
export class MobileAdminController {
  constructor(
    private readonly svc: MobileAdminService,
    private readonly ops: MobileOpsService,
    private readonly blocks: BlocklistService,
  ) {}

  private mbno(v: string): string {
    if (!MBNO.test(v)) throw new BadRequestException('Invalid member number');
    return v;
  }

  @Get('members')
  @ApiOperation({ summary: 'Search members with their mobile access status' })
  search(@Query('q') q = '') {
    return this.svc.searchMembers(q);
  }

  @Get('members/:mbno')
  @ApiOperation({ summary: 'One member: access, phones, codes, requests, recent activity' })
  detail(@Param('mbno') mbno: string) {
    return this.svc.memberDetail(this.mbno(mbno));
  }

  @Post('members/:mbno/activation-code')
  @HttpCode(HttpStatus.OK)
  @RequireAuthCode('mobile_issue_code')
  @ApiOperation({ summary: 'Issue a one-time activation code (shown once)' })
  issueCode(@Param('mbno') mbno: string, @CurrentUser() user: any) {
    return this.svc.issueCode(this.mbno(mbno), staffName(user));
  }

  @Post('members/:mbno/reset-mpin')
  @HttpCode(HttpStatus.OK)
  @RequireAuthCode('mobile_issue_code')
  @ApiOperation({ summary: 'Staff-assisted MPIN reset: sign out everywhere and issue a new code' })
  resetMpin(@Param('mbno') mbno: string, @CurrentUser() user: any) {
    return this.svc.resetMpin(this.mbno(mbno), staffName(user));
  }

  @Post('members/:mbno/unlock')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Unlock a member locked by wrong MPINs' })
  unlock(@Param('mbno') mbno: string, @CurrentUser() user: any) {
    return this.svc.unlock(this.mbno(mbno), staffName(user));
  }

  @Post('members/:mbno/block')
  @HttpCode(HttpStatus.OK)
  @RequireAuthCode('mobile_block_member')
  @ApiOperation({ summary: 'Block mobile access (fraud, death, dispute)' })
  block(@Param('mbno') mbno: string, @Body() dto: BlockDto, @CurrentUser() user: any) {
    return this.svc.block(this.mbno(mbno), dto.reason, staffName(user));
  }

  @Post('members/:mbno/unblock')
  @HttpCode(HttpStatus.OK)
  @RequireAuthCode('mobile_block_member')
  @ApiOperation({ summary: 'Unblock mobile access' })
  unblock(@Param('mbno') mbno: string, @CurrentUser() user: any) {
    return this.svc.unblock(this.mbno(mbno), staffName(user));
  }

  @Post('members/:mbno/sign-out-all')
  @HttpCode(HttpStatus.OK)
  @RequireAuthCode('mobile_block_member')
  @ApiOperation({ summary: 'Lost phone: revoke every phone and session' })
  signOutAll(@Param('mbno') mbno: string, @CurrentUser() user: any) {
    return this.svc.signOutEverywhere(this.mbno(mbno), staffName(user));
  }

  @Post('members/:mbno/verify-app-code')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Check the App Code a member reads out from his phone' })
  verifyAppCode(@Param('mbno') mbno: string, @Body() dto: VerifyCodeDto, @CurrentUser() user: any) {
    return this.svc.verifyAppCode(this.mbno(mbno), dto.code, staffName(user));
  }

  @Get('phone-quality')
  @ApiOperation({ summary: 'How many active members have a usable registered phone (missing / invalid / shared)' })
  phoneQuality() {
    return this.svc.phoneQualitySummary();
  }

  @Get('phone-quality/members')
  @ApiOperation({ summary: 'Members with a missing, invalid or shared phone, to correct at the counter' })
  phoneQualityMembers(@Query('status') status = 'MISSING', @Query('offset') offset = '0', @Query('limit') limit = '100') {
    return this.svc.phoneQualityMembers(status, Number(offset), Number(limit));
  }

  @Get('activation-requests')
  @ApiOperation({ summary: 'Activation requests sent from the app (status NEW, CALLED_BACK, APPROVED, REJECTED or ALL)' })
  requests(@Query('status') status?: string) {
    return this.svc.listRequests(status);
  }

  @Post('activation-requests/:id/called-back')
  @HttpCode(HttpStatus.OK)
  calledBack(@Param('id', ParseIntPipe) id: number, @Body() dto: NoteDto, @CurrentUser() user: any) {
    return this.svc.markCalledBack(id, staffName(user), dto.note);
  }

  @Post('activation-requests/:id/approve')
  @HttpCode(HttpStatus.OK)
  @RequireAuthCode('mobile_issue_code')
  @ApiOperation({ summary: 'Approve after the call-back: issues the activation code (shown once)' })
  approve(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: any) {
    return this.svc.approveRequest(id, staffName(user));
  }

  @Post('activation-requests/:id/reject')
  @HttpCode(HttpStatus.OK)
  reject(@Param('id', ParseIntPipe) id: number, @Body() dto: NoteDto, @CurrentUser() user: any) {
    return this.svc.rejectRequest(id, staffName(user), dto.note);
  }

  // ───────────── features and releases (ES-241) ─────────────

  @Get('features')
  @ApiOperation({ summary: 'Feature switches, minimum/latest app versions and the maintenance message' })
  features() {
    return this.ops.features();
  }

  @Post('features/flags/:key')
  @HttpCode(HttpStatus.OK)
  @RequireAuthCode('mobile_change_features')
  @ApiOperation({ summary: 'Switch one feature on or off for every member' })
  setFlag(@Param('key') key: string, @Body() dto: FlagDto, @CurrentUser() user: any) {
    if (!/^[a-z_]{1,60}$/.test(key)) throw new BadRequestException('Invalid feature name');
    return this.ops.setFlag(key, dto.enabled, staffName(user));
  }

  @Post('features/versions/:platform')
  @HttpCode(HttpStatus.OK)
  @RequireAuthCode('mobile_change_features')
  @ApiOperation({ summary: 'Set the latest and the lowest allowed app version (older apps are told to update)' })
  setVersion(@Param('platform') platform: string, @Body() dto: VersionDto, @CurrentUser() user: any) {
    return this.ops.setVersion(platform, dto, staffName(user));
  }

  @Post('features/maintenance')
  @HttpCode(HttpStatus.OK)
  @RequireAuthCode('mobile_change_features')
  @ApiOperation({ summary: 'Turn maintenance mode on or off (the app shows the message instead of data)' })
  maintenance(@Body() dto: MaintenanceDto, @CurrentUser() user: any) {
    return this.ops.setMaintenance(dto.enabled, dto.message ?? '', staffName(user));
  }

  // ───────────── security and audit (ES-243) ─────────────

  @Get('audit')
  @ApiOperation({ summary: 'Search the member-app audit trail by member, device, IP, event, result and dates' })
  auditSearch(@Query() q: AuditQuery) {
    return this.ops.auditSearch(q);
  }

  @Get('audit/export')
  @ApiOperation({ summary: 'The same search as CSV text (read-only, at most 5000 rows); the window saves it as a file' })
  async auditExport(@Query() q: AuditQuery, @CurrentUser() user: any) {
    const csv = await this.ops.auditCsv(q, staffName(user));
    return { fileName: `mobile-audit-${new Date().toISOString().slice(0, 10)}.csv`, csv: '﻿' + csv };
  }

  @Get('monitors')
  @ApiOperation({ summary: 'Last 24 hours: failed sign-ins, lockouts, top failing IPs and members' })
  monitors() {
    return this.ops.monitors();
  }

  @Get('blocklist')
  @ApiOperation({ summary: 'Phones and IP addresses currently blocked from the app' })
  blocklist() {
    return this.blocks.list();
  }

  @Post('blocklist')
  @HttpCode(HttpStatus.OK)
  @RequireAuthCode('mobile_block_member')
  @ApiOperation({ summary: 'Block a phone (device reference from the audit trail) or an IP address' })
  block_(@Body() dto: BlockTargetDto, @CurrentUser() user: any) {
    // The office PC itself (and the tunnel program on it) arrives as a loopback address: blocking that would lock out every member.
    if (dto.kind === 'IP' && /^(::ffff:)?127\.|^::1$|^0\.0\.0\.0$/i.test(dto.value.trim())) {
      throw new BadRequestException('That is this computer itself. Blocking it would block every member.');
    }
    return this.blocks.block(dto.kind, dto.value, dto.reason, staffName(user));
  }

  @Post('blocklist/:id/unblock')
  @HttpCode(HttpStatus.OK)
  @RequireAuthCode('mobile_block_member')
  unblockTarget(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: any) {
    return this.blocks.unblock(id, staffName(user));
  }
}
