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
    UseGuards,
    UseInterceptors,
    UploadedFile,
    StreamableFile,
    Res,
    ParseFilePipeBuilder,
    HttpStatus,
    NotFoundException,
    Req,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiTags, ApiOperation, ApiResponse, ApiConsumes, ApiBody, ApiBearerAuth } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { MemberCrudService, MemberLookupService, MemberBalanceService, SignatureService } from './services-v2';
import { signatureUploadConfig, photoUploadConfig, documentUploadConfig } from './config/multer.config';
import { createReadStream, existsSync } from 'fs';
import { join, extname } from 'path';
import type { Response } from 'express';
import {
    CreateMemberDto,
    UpdateMemberDto,
    MemberResponseDto,
    SearchMemberDto,
    UpdateMemberStatusDto,
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
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
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

    @Patch(':id/status')
    @ApiOperation({ summary: 'Change a member lifecycle status (active/inactive/resigned/expired/…)' })
    @ApiResponse({ status: 200, description: 'Member status updated' })
    async updateStatus(
        @Param('id', ParseIntPipe) id: number,
        @Body() dto: UpdateMemberStatusDto,
    ): Promise<MemberResponseDto> {
        return this.memberCrudService.updateStatus(id, dto.status, dto.reason);
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
        if (!filePath) throw new NotFoundException('Signature not found');
        const fullPath = join(process.cwd(), filePath);
        if (!existsSync(fullPath)) throw new NotFoundException('Signature file missing on disk');
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

    // ==================== Photo Routes (profile / doc_front / doc_back) ====================

    @Post('master/:mbno/photo/:type')
    @ApiOperation({ summary: 'Upload photo for member_master member (type: profile | doc_front | doc_back)' })
    @ApiConsumes('multipart/form-data')
    @UseInterceptors(FileInterceptor('file', photoUploadConfig))
    async uploadPhotoMaster(
        @Param('mbno') mbno: string,
        @Param('type') type: string,
        @UploadedFile(
            new ParseFilePipeBuilder()
                .addMaxSizeValidator({ maxSize: 5 * 1024 * 1024 })
                .build({ errorHttpStatusCode: HttpStatus.UNPROCESSABLE_ENTITY, fileIsRequired: true }),
        ) file: Express.Multer.File,
    ) {
        await this.signatureService.uploadPhotoMaster(mbno, file.path, type);
        return { message: `Photo (${type}) uploaded successfully`, mbno, type };
    }

    @Get('master/:mbno/photo/:type')
    @ApiOperation({ summary: 'Get photo for member_master member' })
    async getPhotoMaster(
        @Param('mbno') mbno: string,
        @Param('type') type: string,
        @Res({ passthrough: true }) res: Response,
    ): Promise<StreamableFile> {
        const filePath = await this.signatureService.getPhotoPathMaster(mbno, type);
        if (!filePath) throw new NotFoundException('Photo not found');
        const fullPath = join(process.cwd(), filePath);
        if (!existsSync(fullPath)) throw new NotFoundException('Photo file missing on disk');
        const ext = extname(filePath).toLowerCase();
        const mimeType = ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg' : 'image/png';
        res.set({ 'Content-Type': mimeType, 'Content-Disposition': `inline; filename="${type}${ext}"` });
        return new StreamableFile(createReadStream(fullPath));
    }

    @Delete('master/:mbno/photo/:type')
    @ApiOperation({ summary: 'Delete photo for member_master member' })
    async deletePhotoMaster(@Param('mbno') mbno: string, @Param('type') type: string) {
        await this.signatureService.deletePhotoMaster(mbno, type);
        return { message: `Photo (${type}) deleted`, mbno };
    }

    // ==================== KYC Documents (multi-document per member) ====================

    @Post('master/:mbno/document')
    @ApiOperation({ summary: 'Upload a KYC document (body: docType) for a member' })
    @ApiConsumes('multipart/form-data')
    @UseInterceptors(FileInterceptor('file', documentUploadConfig))
    async uploadDocument(
        @Param('mbno') mbno: string,
        @Body('docType') docType: string,
        @UploadedFile(
            new ParseFilePipeBuilder()
                .addMaxSizeValidator({ maxSize: 10 * 1024 * 1024 })
                .build({ errorHttpStatusCode: HttpStatus.UNPROCESSABLE_ENTITY, fileIsRequired: true }),
        ) file: Express.Multer.File,
    ) {
        const doc = await this.signatureService.addDocument(mbno, docType, file.path, file.originalname);
        return { message: 'Document uploaded', mbno, document: doc };
    }

    @Get('master/:mbno/documents')
    @ApiOperation({ summary: 'List KYC documents for a member' })
    async listDocuments(@Param('mbno') mbno: string) {
        return this.signatureService.listDocuments(mbno);
    }

    @Get('master/:mbno/document/:id')
    @ApiOperation({ summary: 'Stream/download a KYC document file' })
    async getDocument(
        @Param('mbno') mbno: string,
        @Param('id') id: string,
        @Res({ passthrough: true }) res: Response,
    ): Promise<StreamableFile> {
        const filePath = await this.signatureService.getDocumentPath(parseInt(id, 10), mbno);
        if (!filePath) throw new NotFoundException('Document not found');
        const fullPath = join(process.cwd(), filePath);
        if (!existsSync(fullPath)) throw new NotFoundException('Document file missing on disk');
        const ext = extname(filePath).toLowerCase();
        const mimeType = ext === '.pdf' ? 'application/pdf' : (ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg' : 'image/png');
        res.set({ 'Content-Type': mimeType, 'Content-Disposition': `inline; filename="document${ext}"` });
        return new StreamableFile(createReadStream(fullPath));
    }

    @Delete('master/:mbno/document/:id')
    @ApiOperation({ summary: 'Delete a KYC document' })
    async deleteDocument(@Param('mbno') mbno: string, @Param('id') id: string) {
        await this.signatureService.deleteDocument(parseInt(id, 10), mbno);
        return { message: 'Document deleted', id };
    }

    // ==================== Legacy Support ====================

    @Post('save-member')
    @ApiOperation({ summary: 'Save member to legacy member_master table' })
    async saveMemberMaster(@Body() memberData: any, @Req() req: any) {
        const username = req.user?.susername || req.user?.username || 'system';
        return this.memberCrudService.saveMemberMaster(memberData, username);
    }
}
