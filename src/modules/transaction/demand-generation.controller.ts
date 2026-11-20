import { RequireMenuAction } from '../auth/guards/menu-right.guard';
import { Controller, Post, Body, Req, UseInterceptors, UploadedFile, BadRequestException, UseGuards } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiTags, ApiOperation, ApiResponse, ApiConsumes } from '@nestjs/swagger';
import { DemandGenerationService, DemandGenerationDto } from './services-v2/demand-generation.service';
import { DemandImportService } from './services-v2/demand-import.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';

const MONTH_MAP: Record<string, number> = {
    JAN: 1, FEB: 2, MAR: 3, APR: 4, MAY: 5, JUN: 6,
    JUL: 7, AUG: 8, SEP: 9, OCT: 10, NOV: 11, DEC: 12,
};

@ApiTags('Transaction - Demand Generation')
@Controller('transactions/demand-generation')
@UseGuards(JwtAuthGuard)
export class DemandGenerationController {
    constructor(
        private readonly service: DemandGenerationService,
        private readonly importService: DemandImportService,
    ) { }

    @RequireMenuAction('GENERATE') // ES-464
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
        const monthNum = MONTH_MAP[(body.month || '').toUpperCase()] || undefined;
        const yearNum = parseInt(body.year || '', 10) || undefined;
        const preview = await this.importService.previewFromBuffer(file.buffer, body.branch, monthNum, yearNum);
        return {
            rows: preview.rows,
            // file-level notices (e.g. the file's month differs from the selected one); the screen shows them as warnings
            validationErrors: preview.warnings,
            summary: {
                sheetName: preview.sheetName,
                availableSheets: preview.availableSheets,
                total: preview.totalRows,
                valid: preview.validCount,
                errors: preview.errorCount,
                flagged: preview.flaggedCount,
                columns: preview.columnsDetected,
                matchedBy: preview.matchedBy,
                fileName: file.originalname,
                // ES-591: the strictness from Modify Business Rules (STRICT = any problem and nothing is saved)
                strictness: preview.strictness,
            },
        };
    }

    @RequireMenuAction('IMPORT_DEMAND_LIST') // ES-464
    @Post('import-process')
    @ApiOperation({ summary: 'Save previously-previewed demand import rows for the selected month/year' })
    async processImport(@Req() req: any, @Body() body: { month: string; year: string; branch?: string; fileName?: string; data: any[] }) {
        const monthNum = MONTH_MAP[(body.month || '').toUpperCase()] || 0;
        const yearNum = parseInt(body.year, 10) || 0;
        if (!monthNum || !yearNum) {
            throw new BadRequestException(`Invalid month/year: ${body.month} ${body.year}`);
        }
        if (!body.data || body.data.length === 0) {
            return { success: false, message: 'No records to process.' };
        }
        // ES-588: the saving user comes from the token, never from the request body
        const result = await this.importService.saveRows(monthNum, yearNum, body.data as any, body.branch, {
            fileName: body.fileName,
            savedBy: req?.user?.username || 'admin',
        });
        return {
            success: true,
            recordCount: result.saved,
            skipped: result.skipped,
            flagged: result.flagged,
            batchId: result.batchId,
            strictness: result.strictness,
            skippedDetails: result.skippedDetails.slice(0, 50),
            message: `Saved ${result.saved} record(s)${result.skipped > 0 ? `, skipped ${result.skipped} row(s)` : ''}${result.flagged > 0 ? `; ${result.flagged} row(s) need checking (possible old/new EMI mix-up)` : ''}.`,
        };
    }
}
