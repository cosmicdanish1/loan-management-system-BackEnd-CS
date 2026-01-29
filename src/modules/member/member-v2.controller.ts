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
import { createReadStream } from 'fs';
import { join } from 'path';
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
                .addFileTypeValidator({
                    fileType: /(jpg|jpeg|png)$/,
                })
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
            // Handle no signature case - maybe return a default placeholder or 404
            // For now, let's return 404 via service if file not found, but service returns path.
            // If path is null, return 404
            const notFoundExc = new Error('Signature not found');
            (notFoundExc as any).status = 404;
            throw notFoundExc;
        }

        const fullPath = join(process.cwd(), filePath);
        const file = createReadStream(fullPath);

        res.set({
            'Content-Type': 'image/png', // Adjust based on extension if needed
            'Content-Disposition': 'inline; filename="signature.png"',
        });

        return new StreamableFile(file);
    }

    @Delete(':id/signature')
    @ApiOperation({ summary: 'Delete member signature' })
    async deleteSignature(@Param('id', ParseIntPipe) id: number) {
        return this.signatureService.deleteSignature(id);
    }

    // ==================== Legacy Support ====================

    @Post('save-member')
    @ApiOperation({ summary: 'Save member to legacy member_master table' })
    async saveMemberMaster(@Body() memberData: any) {
        return this.memberCrudService.saveMemberMaster(memberData);
    }
}
