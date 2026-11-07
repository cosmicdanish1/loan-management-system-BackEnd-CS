import { Controller, Get, Headers, Param, Query, UseGuards, UseInterceptors } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { IsInt, IsOptional, IsString, Matches, Max, Min } from 'class-validator';
import { Public } from '../../auth/decorators';
import { MobileAudit, MobileAuditInterceptor } from '../audit/mobile-audit.interceptor';
import { CurrentMember, MemberJwtGuard } from '../auth/member-jwt.guard';
import { CurrentMemberInfo } from '../auth/member-jwt.strategy';
import { MobileThrottlerGuard } from '../security/mobile-throttler.guard';
import { MemberDataService } from './member-data.service';

class PageQuery {
  @IsOptional() @IsString() cursor?: string;
  @IsOptional() @IsInt() @Min(1) @Max(100) limit?: number;
}

class LedgerQuery extends PageQuery {
  @IsString() @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'from must be YYYY-MM-DD' }) from: string;
  @IsString() @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'to must be YYYY-MM-DD' }) to: string;
}

const ctx = (m: CurrentMemberInfo) => ({ mbno: m.mbno, deviceId: m.deviceId });

/**
 * A member's own data. The member is ALWAYS the signed-in one (token); there is no route that takes a member number.
 * @Public() only switches off the staff login guard; MemberJwtGuard is the real guard.
 */
@ApiTags('Mobile member data')
@ApiBearerAuth()
@Public()
@UseGuards(MobileThrottlerGuard, MemberJwtGuard)
@UseInterceptors(MobileAuditInterceptor)
@Controller('mobile')
export class MemberDataController {
  constructor(private readonly data: MemberDataService) {}

  @Get('home')
  @ApiOperation({ summary: 'One-call dashboard: balances, next EMI, notice count' })
  home(@CurrentMember() m: CurrentMemberInfo) {
    return this.data.home(ctx(m));
  }

  @Get('profile')
  @ApiOperation({ summary: 'Own profile and nominee (identifiers masked)' })
  profile(@CurrentMember() m: CurrentMemberInfo) {
    return this.data.profile(ctx(m));
  }

  @Get('accounts')
  @ApiOperation({ summary: 'Shares, compulsory deposit and savings accounts' })
  accounts(@CurrentMember() m: CurrentMemberInfo) {
    return this.data.accounts(ctx(m));
  }

  @Get('loans')
  @ApiOperation({ summary: 'Own loans (active first)' })
  loans(@CurrentMember() m: CurrentMemberInfo) {
    return this.data.loans(ctx(m));
  }

  @Get('loans/:loanType/:caseNo')
  @ApiOperation({ summary: 'One loan: identified by loan type + case number (case numbers alone are not unique)' })
  loan(@CurrentMember() m: CurrentMemberInfo, @Param('loanType') loanType: string, @Param('caseNo') caseNo: string) {
    return this.data.loan(ctx(m), loanType, caseNo);
  }

  @Get('loans/:loanType/:caseNo/schedule')
  @ApiOperation({ summary: 'EMI schedule' })
  schedule(@CurrentMember() m: CurrentMemberInfo, @Param('loanType') loanType: string, @Param('caseNo') caseNo: string) {
    return this.data.schedule(ctx(m), loanType, caseNo);
  }

  @Get('loans/:loanType/:caseNo/payments')
  @ApiOperation({ summary: 'Repayments received, newest first (cursor paging)' })
  payments(@CurrentMember() m: CurrentMemberInfo, @Param('loanType') loanType: string, @Param('caseNo') caseNo: string, @Query() q: PageQuery) {
    return this.data.payments(ctx(m), loanType, caseNo, q.cursor, q.limit);
  }

  @Get('ledger')
  @MobileAudit('LEDGER_VIEW')
  @ApiOperation({ summary: 'Passbook / member ledger for a date range, newest first. Older than 12 months needs the App Code approval (LARGE_STATEMENT).' })
  ledger(@CurrentMember() m: CurrentMemberInfo, @Query() q: LedgerQuery, @Headers('x-step-up-approval') approval?: string) {
    return this.data.ledgerPage(ctx(m), q, approval);
  }

  @Get('notices')
  @ApiOperation({ summary: 'Notices published for the mobile app and meant for this member' })
  notices(@CurrentMember() m: CurrentMemberInfo) {
    return this.data.notices(ctx(m));
  }
}
