import { Controller, Get, Query, Logger } from '@nestjs/common';
import { ApiTags, ApiOperation } from '@nestjs/swagger';
import { MemberLedgerService } from './member-ledger.service';
import {
  GetMemberLedgerDto,
  MemberLedgerSummaryDto,
  HeadMasterDto,
  ValidateMemberDto,
  GetMemberDetailLedgerDto,
  MemberDetailLedgerSummaryDto,
  MemberColumnarLedgerDto
} from './dto/member-ledger.dto';

@ApiTags('Member Ledger')
@Controller('member-ledger')
export class MemberLedgerController {
  private readonly logger = new Logger(MemberLedgerController.name);

  constructor(private readonly memberLedgerService: MemberLedgerService) { }

  @ApiOperation({ summary: 'Member ledger for a single head/account over a date range' })
  @Get('report')
  async getMemberLedgerReport(@Query() dto: GetMemberLedgerDto): Promise<MemberLedgerSummaryDto> {
    this.logger.log(`Generating member ledger report for member: ${dto.memberNumber}, head: ${dto.headCode}, period: ${dto.fromDate} to ${dto.toDate}`);

    const report = await this.memberLedgerService.getMemberLedgerReport(dto);

    return report;
  }

  @ApiOperation({ summary: 'Detailed member ledger across all heads over a date range' })
  @Get('detail-report')
  async getMemberDetailLedgerReport(@Query() dto: GetMemberDetailLedgerDto): Promise<MemberDetailLedgerSummaryDto> {
    this.logger.log(`Generating member detail ledger report for member: ${dto.memberNumber}, period: ${dto.fromDate} to ${dto.toDate}`);

    const report = await this.memberLedgerService.getMemberDetailLedgerReport(dto);

    return report;
  }

  @ApiOperation({ summary: 'Columnar member ledger (Share/LTL/Emergency/CD columns with per-date Dr/Cr/Bal)' })
  @Get('detail-columnar')
  async getMemberColumnarLedger(@Query() dto: GetMemberDetailLedgerDto): Promise<MemberColumnarLedgerDto> {
    this.logger.log(`Generating columnar member ledger for member: ${dto.memberNumber}, period: ${dto.fromDate} to ${dto.toDate}`);

    return this.memberLedgerService.getMemberColumnarLedger(dto);
  }

  @ApiOperation({ summary: 'Check a member number exists and return the member name' })
  @Get('validate-member')
  async validateMember(@Query() dto: ValidateMemberDto): Promise<{ exists: boolean; memberName?: string; memberNumber: string }> {
    this.logger.log(`Validating member: ${dto.memberNumber}`);

    const result = await this.memberLedgerService.validateMember(dto);

    return result;
  }

  @ApiOperation({ summary: 'List account head masters (for ledger head dropdowns)' })
  @Get('head-masters')
  async getHeadMasters(): Promise<HeadMasterDto[]> {
    this.logger.log('Fetching head masters for dropdown');

    const heads = await this.memberLedgerService.getHeadMasters();

    return heads;
  }


}