import { Controller, Get, Query, Logger } from '@nestjs/common';
import { MemberLedgerService } from './member-ledger.service';
import {
  GetMemberLedgerDto,
  MemberLedgerSummaryDto,
  HeadMasterDto,
  ValidateMemberDto,
  GetMemberDetailLedgerDto,
  MemberDetailLedgerSummaryDto
} from './dto/member-ledger.dto';

@Controller('member-ledger')
export class MemberLedgerController {
  private readonly logger = new Logger(MemberLedgerController.name);

  constructor(private readonly memberLedgerService: MemberLedgerService) { }

  @Get('report')
  async getMemberLedgerReport(@Query() dto: GetMemberLedgerDto): Promise<MemberLedgerSummaryDto> {
    this.logger.log(`Generating member ledger report for member: ${dto.memberNumber}, head: ${dto.headCode}, period: ${dto.fromDate} to ${dto.toDate}`);

    const report = await this.memberLedgerService.getMemberLedgerReport(dto);

    return report;
  }

  @Get('detail-report')
  async getMemberDetailLedgerReport(@Query() dto: GetMemberDetailLedgerDto): Promise<MemberDetailLedgerSummaryDto> {
    this.logger.log(`Generating member detail ledger report for member: ${dto.memberNumber}, period: ${dto.fromDate} to ${dto.toDate}`);

    const report = await this.memberLedgerService.getMemberDetailLedgerReport(dto);

    return report;
  }

  @Get('validate-member')
  async validateMember(@Query() dto: ValidateMemberDto): Promise<{ exists: boolean; memberName?: string; memberNumber: string }> {
    this.logger.log(`Validating member: ${dto.memberNumber}`);

    const result = await this.memberLedgerService.validateMember(dto);

    return result;
  }

  @Get('head-masters')
  async getHeadMasters(): Promise<HeadMasterDto[]> {
    this.logger.log('Fetching head masters for dropdown');

    const heads = await this.memberLedgerService.getHeadMasters();

    return heads;
  }


}