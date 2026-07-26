import { Controller, Post, Body, UseInterceptors, UploadedFile } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiTags, ApiOperation, ApiResponse, ApiConsumes } from '@nestjs/swagger';
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
    @ApiConsumes('multipart/form-data')
    @UseInterceptors(FileInterceptor('file'))
    @ApiOperation({ summary: 'Parse Excel/CSV file and return preview data' })
    async previewImport(
        @UploadedFile() file: Express.Multer.File,
        @Body() body: any,
    ) {
        return this.service.previewDemandImport(file, body.month, body.year, body.branch);
    }

    @Post('import-process')
    @ApiOperation({ summary: 'Save imported demand data to demand_master' })
    async processImport(@Body() body: any) {
        return this.service.processDemandImport(body.month, body.year, body.branch, body.data);
    }
}
