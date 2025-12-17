import { Controller, Get, Query, Logger } from '@nestjs/common';
import { MemberLedgerService } from './member-ledger.service';
import { 
  GetMemberLedgerDto, 
  MemberLedgerSummaryDto,
  HeadMasterDto,
  ValidateMemberDto
} from './dto/member-ledger.dto';

@Controller('member-ledger')
export class MemberLedgerController {
  private readonly logger = new Logger(MemberLedgerController.name);

  constructor(private readonly memberLedgerService: MemberLedgerService) {}

  @Get('report')
  async getMemberLedgerReport(@Query() dto: GetMemberLedgerDto): Promise<{
    success: boolean;
    data: MemberLedgerSummaryDto;
    message: string;
  }> {
    this.logger.log(`Generating member ledger report for member: ${dto.memberNumber}, head: ${dto.headCode}, period: ${dto.fromDate} to ${dto.toDate}`);
    
    const report = await this.memberLedgerService.getMemberLedgerReport(dto);
    
    return {
      success: true,
      data: report,
      message: 'Member ledger report generated successfully'
    };
  }

  @Get('validate-member')
  async validateMember(@Query() dto: ValidateMemberDto): Promise<{
    success: boolean;
    data: { exists: boolean; memberName?: string; memberNumber: string };
    message: string;
  }> {
    this.logger.log(`Validating member: ${dto.memberNumber}`);
    
    const result = await this.memberLedgerService.validateMember(dto);
    
    return {
      success: true,
      data: result,
      message: result.exists ? 'Member found' : 'Member not found'
    };
  }

  @Get('head-masters')
  async getHeadMasters(): Promise<{
    success: boolean;
    data: HeadMasterDto[];
    message: string;
  }> {
    this.logger.log('Fetching head masters for dropdown');
    
    const heads = await this.memberLedgerService.getHeadMasters();
    
    return {
      success: true,
      data: heads,
      message: 'Head masters retrieved successfully'
    };
  }


}