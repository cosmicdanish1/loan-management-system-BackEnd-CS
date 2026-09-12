import {
    Controller,
    Get,
    Post,
    Body,
    Patch,
    Param,
    Delete,
    Query,
    ParseIntPipe,
    UseInterceptors,
    UploadedFile,
    StreamableFile,
    Res,
    ParseFilePipeBuilder,
    HttpStatus,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiTags, ApiOperation, ApiResponse, ApiConsumes, ApiBody } from '@nestjs/swagger';
import { MemberCrudService, MemberLookupService, MemberBalanceService, SignatureService } from './services-v2';
import { signatureUploadConfig } from './config/multer.config';
import { createReadStream, existsSync } from 'fs';
import { join, extname } from 'path';
import type { Response } from 'express';
import {
    CreateMemberDto,
    UpdateMemberDto,
    MemberResponseDto,
    SearchMemberDto,
} from './dto';

/**
 * Member V2 Controller - Restructured endpoints using separated services.
 * 
 * @version 2.0 - Part of backend restructuring
 * 
 * All routes are prefixed with /v2/members to run alongside original routes.
 * After migration is complete, these will replace the original routes.
 */
@ApiTags('Members')
@Controller('members')
export class MemberV2Controller {
    constructor(
        private readonly memberCrudService: MemberCrudService,
        private readonly memberLookupService: MemberLookupService,
        private readonly memberBalanceService: MemberBalanceService,
        private readonly signatureService: SignatureService,
    ) { }

    // ==================== CRUD Operations ====================

    @Post()
    @ApiOperation({ summary: 'Create a new member' })
    @ApiResponse({ status: 201, description: 'Member created successfully' })
    async create(@Body() createMemberDto: CreateMemberDto): Promise<MemberResponseDto> {
        return this.memberCrudService.create(createMemberDto);
    }

    @Get()
    @ApiOperation({ summary: 'Get all members with pagination' })
    async findAll(@Query() searchDto: SearchMemberDto) {
        return this.memberCrudService.findAll(searchDto);
    }

    // ==================== Specific Routes (Must come before :id) ====================

    @Get('statistics')
    @ApiOperation({ summary: 'Get member statistics' })
    async getStatistics() {
        return this.memberCrudService.getStatistics();
    }

    @Get('lookup')
    @ApiOperation({ summary: 'Lookup members for forms and dropdowns' })
    async lookupMembers(
        @Query('search') search?: string,
        @Query('limit') limit?: number,
        @Query('offset') offset?: number
    ) {
        return this.memberLookupService.lookupMembers(search, limit, offset);
    }

    @Get('details/:memberNo')
    @ApiOperation({ summary: 'Get member details by member number' })
    async getMemberDetails(@Param('memberNo') memberNo: string) {
        return this.memberLookupService.getMemberDetailsByNumber(memberNo);
    }

    @Get('find/:memberNo')
    @ApiOperation({ summary: 'Find member by member number' })
    async findByMemberNumber(@Param('memberNo') memberNo: string) {
        return this.memberLookupService.findByMemberNumber(memberNo);
    }

    @Get('generate/member-number')
    @ApiOperation({ summary: 'Generate next sequential member number' })
    async generateMemberNumber() {
        // This logic is in MemberCrudService.create but we expose it for form pre-filling
        const memberNumber = await this.memberCrudService.generateNextMemberNumber();
        return { memberNumber };
    }

    // ==================== Parameterized Routes ====================

    @Get(':id')
    @ApiOperation({ summary: 'Get member by ID' })
    async findOne(@Param('id', ParseIntPipe) id: number): Promise<MemberResponseDto> {
        return this.memberCrudService.findOne(id);
    }

    @Patch(':id')
    @ApiOperation({ summary: 'Update member' })
    async update(
        @Param('id', ParseIntPipe) id: number,
        @Body() updateMemberDto: UpdateMemberDto,
    ): Promise<MemberResponseDto> {
        return this.memberCrudService.update(id, updateMemberDto);
    }

    @Delete(':id')
    @ApiOperation({ summary: 'Delete member' })
    async remove(@Param('id', ParseIntPipe) id: number): Promise<void> {
        return this.memberCrudService.remove(id);
    }

    // ==================== Balance Operations ====================

    @Get('balance/:memberNo')
    @ApiOperation({ summary: 'Get comprehensive member balance' })
    async getMemberBalance(@Param('memberNo') memberNo: string) {
        return this.memberBalanceService.getMemberBalance(memberNo);
    }

    @Get('balance/:memberNo/quick')
    @ApiOperation({ summary: 'Get quick balance summary' })
    async getQuickBalance(@Param('memberNo') memberNo: string) {
        return this.memberBalanceService.getQuickBalance(memberNo);
    }

    // ==================== Signature Operations ====================

    @Post(':id/signature')
    @ApiOperation({ summary: 'Upload member signature' })
    @ApiConsumes('multipart/form-data')
    @ApiBody({
        schema: {
            type: 'object',
            properties: {
                file: {
                    type: 'string',
                    format: 'binary',
                },
            },
        },
    })
    @UseInterceptors(FileInterceptor('file', signatureUploadConfig))
    async uploadSignature(
        @Param('id', ParseIntPipe) id: number,
        @UploadedFile(
            new ParseFilePipeBuilder()
                // NOTE: addFileTypeValidator is intentionally omitted.
                // NestJS FileTypeValidator reads file.buffer, which diskStorage never populates.
                // MIME-type filtering is handled by signatureUploadConfig.fileFilter in multer.config.ts.
                .addMaxSizeValidator({
                    maxSize: 2 * 1024 * 1024, // 2MB
                })
                .build({
                    errorHttpStatusCode: HttpStatus.UNPROCESSABLE_ENTITY,
                    fileIsRequired: true,
                }),
        ) file: Express.Multer.File,
    ) {
        return this.signatureService.uploadSignature(id, file.path);
    }

    @Get(':id/signature')
    @ApiOperation({ summary: 'Get member signature image' })
    async getSignature(
        @Param('id', ParseIntPipe) id: number,
        @Res({ passthrough: true }) res: Response,
    ): Promise<StreamableFile> {
        const filePath = await this.signatureService.getSignaturePath(id);

        if (!filePath) {
            const notFoundExc = new Error('Signature not found');
            (notFoundExc as any).status = 404;
            throw notFoundExc;
        }

        const fullPath = join(process.cwd(), filePath);
        // BUG FIX 4: guard against orphan DB reference when file deleted from disk
        if (!existsSync(fullPath)) {
            const notFoundExc = new Error('Signature file missing on disk');
            (notFoundExc as any).status = 404;
            throw notFoundExc;
        }

        // BUG FIX 5: derive MIME type from actual file extension, not hardcoded png
        const ext = extname(filePath).toLowerCase();
        const mimeType = ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg' : 'image/png';
        res.set({
            'Content-Type': mimeType,
            'Content-Disposition': `inline; filename="signature${ext}"`,
        });

        return new StreamableFile(createReadStream(fullPath));
    }

    @Delete(':id/signature')
    @ApiOperation({ summary: 'Delete member signature' })
    async deleteSignature(@Param('id', ParseIntPipe) id: number) {
        return this.signatureService.deleteSignature(id);
    }

    // ==================== member_master Signature Routes (legacy members) ====================
    // BUG FIX 1+2: The /:id/signature routes above use the TypeORM `members` table (new system).
    // Real members live in member_master and are identified by mbno (string).
    // These routes use mbno and store paths in member_master.signature_image_path.

    @Post('master/:mbno/signature')
    @ApiOperation({ summary: 'Upload signature for legacy member_master member' })
    @ApiConsumes('multipart/form-data')
    @UseInterceptors(FileInterceptor('file', signatureUploadConfig))
    async uploadSignatureMaster(
        @Param('mbno') mbno: string,
        @UploadedFile(
            new ParseFilePipeBuilder()
                // NOTE: addFileTypeValidator omitted — diskStorage does not populate file.buffer,
                // so NestJS FileTypeValidator always fails. MIME filtering is done by multer.config.ts fileFilter.
                .addMaxSizeValidator({ maxSize: 2 * 1024 * 1024 })
                .build({ errorHttpStatusCode: HttpStatus.UNPROCESSABLE_ENTITY, fileIsRequired: true }),
        ) file: Express.Multer.File,
    ) {
        await this.signatureService.uploadSignatureMaster(mbno, file.path);
        return { message: 'Signature uploaded successfully', mbno };
    }

    @Get('master/:mbno/signature')
    @ApiOperation({ summary: 'Get signature image for legacy member_master member' })
    async getSignatureMaster(
        @Param('mbno') mbno: string,
        @Res({ passthrough: true }) res: Response,
    ): Promise<StreamableFile> {
        const filePath = await this.signatureService.getSignaturePathMaster(mbno);
        if (!filePath) {
            const e = new Error('Signature not found'); (e as any).status = 404; throw e;
        }
        const fullPath = join(process.cwd(), filePath);
        if (!existsSync(fullPath)) {
            const e = new Error('Signature file missing on disk'); (e as any).status = 404; throw e;
        }
        const ext = extname(filePath).toLowerCase();
        const mimeType = ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg' : 'image/png';
        res.set({ 'Content-Type': mimeType, 'Content-Disposition': `inline; filename="signature${ext}"` });
        return new StreamableFile(createReadStream(fullPath));
    }

    @Delete('master/:mbno/signature')
    @ApiOperation({ summary: 'Delete signature for legacy member_master member' })
    async deleteSignatureMaster(@Param('mbno') mbno: string) {
        await this.signatureService.deleteSignatureMaster(mbno);
        return { message: 'Signature deleted', mbno };
    }

    // ==================== Legacy Support ====================

    @Post('save-member')
    @ApiOperation({ summary: 'Save member to legacy member_master table' })
    async saveMemberMaster(@Body() memberData: any) {
        return this.memberCrudService.saveMemberMaster(memberData);
    }
}
