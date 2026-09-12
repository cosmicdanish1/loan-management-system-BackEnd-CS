import { Controller, Post, Body, UseInterceptors, UploadedFile, BadRequestException } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiTags, ApiOperation, ApiResponse, ApiConsumes } from '@nestjs/swagger';
import { DemandGenerationService, DemandGenerationDto } from './services-v2/demand-generation.service';
import { DemandImportService } from './services-v2/demand-import.service';

const MONTH_MAP: Record<string, number> = {
    JAN: 1, FEB: 2, MAR: 3, APR: 4, MAY: 5, JUN: 6,
    JUL: 7, AUG: 8, SEP: 9, OCT: 10, NOV: 11, DEC: 12,
};

@ApiTags('Transaction - Demand Generation')
@Controller('transactions/demand-generation')
export class DemandGenerationController {
    constructor(
        private readonly service: DemandGenerationService,
        private readonly importService: DemandImportService,
    ) { }

    @Post('generate')
    @ApiOperation({ summary: 'Generate demand specifically for a period' })
    @ApiResponse({ status: 201, description: 'Demand generated successfully' })
    generate(@Body() dto: DemandGenerationDto) {
        return this.service.generateDemand(dto);
    }

    // BUG FIX: this endpoint never actually read the uploaded file at all —
    // no FileInterceptor, no spreadsheet library was even installed in this
    // backend. Confirmed live: uploading a file containing the literal text
    // "test" returned a "successful" preview of 15 real members with fully
    // random demand amounts, unrelated to the file's real content. Real
    // parsing (xlsx) now reads the actual sheet/columns.
    @Post('import-preview')
    @ApiConsumes('multipart/form-data')
    @ApiOperation({ summary: 'Preview demand list import from a real uploaded Excel/CSV file' })
    @UseInterceptors(FileInterceptor('file'))
    async previewImport(
        @UploadedFile() file: Express.Multer.File,
        @Body() body: { month?: string; year?: string; branch?: string },
    ) {
        if (!file || !file.buffer) {
            throw new BadRequestException('No file was uploaded.');
        }
        const preview = await this.importService.previewFromBuffer(file.buffer, body.branch);
        return {
            rows: preview.rows,
            summary: {
                sheetName: preview.sheetName,
                availableSheets: preview.availableSheets,
                total: preview.totalRows,
                valid: preview.validCount,
                errors: preview.errorCount,
                columns: preview.columnsDetected,
            },
        };
    }

    @Post('import-process')
    @ApiOperation({ summary: 'Save previously-previewed demand import rows for the selected month/year' })
    async processImport(@Body() body: { month: string; year: string; data: any[] }) {
        const monthNum = MONTH_MAP[(body.month || '').toUpperCase()] || 0;
        const yearNum = parseInt(body.year, 10) || 0;
        if (!monthNum || !yearNum) {
            throw new BadRequestException(`Invalid month/year: ${body.month} ${body.year}`);
        }
        if (!body.data || body.data.length === 0) {
            return { success: false, message: 'No records to process.' };
        }
        const result = await this.importService.saveRows(monthNum, yearNum, body.data as any);
        return {
            success: true,
            recordCount: result.saved,
            skipped: result.skipped,
            message: `Saved ${result.saved} record(s)${result.skipped > 0 ? `, skipped ${result.skipped} invalid row(s)` : ''}.`,
        };
    }
}
