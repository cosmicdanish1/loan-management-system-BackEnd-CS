import { Controller, Post, Body } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse } from '@nestjs/swagger';
import { DemandGenerationService, DemandGenerationDto } from './services-v2/demand-generation.service';

@ApiTags('Transaction - Demand Generation')
@Controller('transactions/demand-generation')
export class DemandGenerationController {
    constructor(private readonly service: DemandGenerationService) { }

    @Post('generate')
    @ApiOperation({ summary: 'Generate demand specifically for a period' })
    @ApiResponse({ status: 201, description: 'Demand generated successfully' })
    generate(@Body() dto: DemandGenerationDto) {
        return this.service.generateDemand(dto);
    }

    @Post('import-preview')
    @ApiOperation({ summary: 'Preview demand list import' })
    async previewImport(@Body() body: any) {
        return this.service.previewDemandImport(body.month, body.year);
    }

    @Post('import-process')
    @ApiOperation({ summary: 'Process demand list import' })
    async processImport(@Body() body: any) {
        return this.service.processDemandImport(body.month, body.year, body.data);
    }
}
