import { BadRequestException, Body, Controller, Get, HttpCode, HttpStatus, Param, ParseIntPipe, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { IsOptional, IsString, Length, Matches, MaxLength } from 'class-validator';
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
  constructor(private readonly svc: MobileAdminService) {}

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
}
