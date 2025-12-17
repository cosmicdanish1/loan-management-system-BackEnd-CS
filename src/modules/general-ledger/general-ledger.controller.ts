import { Controller, Get, Query, ValidationPipe } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse } from '@nestjs/swagger';
import { GeneralLedgerService } from './general-ledger.service';
import { 
  GetGeneralLedgerDto, 
  GeneralLedgerSummaryDto,
  HeadMasterDto
} from './dto/general-ledger.dto';

@ApiTags('general-ledger')
@Controller('general-ledger')
export class GeneralLedgerController {
  constructor(private readonly generalLedgerService: GeneralLedgerService) {}

  @Get('report')
  @ApiOperation({ summary: 'Generate general ledger report' })
  @ApiResponse({ 
    status: 200, 
    description: 'General ledger report generated successfully',
    type: GeneralLedgerSummaryDto
  })
  async getGeneralLedgerReport(
    @Query(ValidationPipe) dto: GetGeneralLedgerDto
  ): Promise<{
    success: boolean;
    data: GeneralLedgerSummaryDto;
    message: string;
  }> {
    const data = await this.generalLedgerService.getGeneralLedgerReport(dto);
    return {
      success: true,
      data,
      message: 'General ledger report generated successfully'
    };
  }

  @Get('head-masters')
  @ApiOperation({ summary: 'Get all head masters for dropdown' })
  @ApiResponse({ 
    status: 200, 
    description: 'Head masters retrieved successfully',
    type: [HeadMasterDto]
  })
  async getHeadMasters(): Promise<{
    success: boolean;
    data: HeadMasterDto[];
    message: string;
  }> {
    const data = await this.generalLedgerService.getHeadMasters();
    return {
      success: true,
      data,
      message: 'Head masters retrieved successfully'
    };
  }
}