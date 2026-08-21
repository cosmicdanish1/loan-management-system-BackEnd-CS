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

  // BUG FIX: manually wrapped in {success, data, message} on top of the global
  // TransformInterceptor's identical wrap — same pattern as daybook.controller.ts.
  // Harmless (frontend already defensively unwraps both shapes) but fixed for
  // consistency.
  @ApiOperation({ summary: 'Consolidation report (all-branch day totals) for a given date' })
  @Get('report')
  async getConsolidationReport(@Query() dto: GetConsolidationDto): Promise<ConsolidationSummaryDto> {
    this.logger.log(`Generating consolidation report for date: ${dto.date}, output: ${dto.outputType || 'screen'}`);
    return this.consolidationService.getConsolidationReport(dto);
  }
}