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

  // BUG FIX: both endpoints manually wrapped their payload in
  // {success, data, message} on top of the global TransformInterceptor's
  // identical wrap — same double-wrap pattern fixed repeatedly this session.
  // Harmless here (frontend already defensively unwraps both shapes) but
  // fixed for consistency.
  @Get('report')
  @ApiOperation({ summary: 'Generate general ledger report' })
  @ApiResponse({
    status: 200,
    description: 'General ledger report generated successfully',
    type: GeneralLedgerSummaryDto
  })
  async getGeneralLedgerReport(
    @Query(ValidationPipe) dto: GetGeneralLedgerDto
  ): Promise<GeneralLedgerSummaryDto> {
    return this.generalLedgerService.getGeneralLedgerReport(dto);
  }

  @Get('head-masters')
  @ApiOperation({ summary: 'Get all head masters for dropdown' })
  @ApiResponse({
    status: 200,
    description: 'Head masters retrieved successfully',
    type: [HeadMasterDto]
  })
  async getHeadMasters(): Promise<HeadMasterDto[]> {
    return this.generalLedgerService.getHeadMasters();
  }
}