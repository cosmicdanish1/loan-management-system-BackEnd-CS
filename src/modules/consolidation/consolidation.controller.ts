import { Controller, Get, Query, Logger } from '@nestjs/common';
import { ApiTags, ApiOperation } from '@nestjs/swagger';
import { ConsolidationService } from './consolidation.service';
import {
  GetConsolidationDto,
  ConsolidationSummaryDto
} from './dto/consolidation.dto';

@ApiTags('Consolidation')
@Controller('consolidation')
export class ConsolidationController {
  private readonly logger = new Logger(ConsolidationController.name);

  constructor(private readonly consolidationService: ConsolidationService) {}

  @ApiOperation({ summary: 'Consolidation report (all-branch day totals) for a given date' })
  @Get('report')
  async getConsolidationReport(@Query() dto: GetConsolidationDto): Promise<{
    success: boolean;
    data: ConsolidationSummaryDto;
    message: string;
  }> {
    this.logger.log(`Generating consolidation report for date: ${dto.date}, output: ${dto.outputType || 'screen'}`);
    
    const report = await this.consolidationService.getConsolidationReport(dto);
    
    return {
      success: true,
      data: report,
      message: 'Consolidation report generated successfully'
    };
  }
}