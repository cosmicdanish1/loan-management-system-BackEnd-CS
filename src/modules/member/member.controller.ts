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
  HttpCode,
  HttpStatus,
  UseGuards,
  UseInterceptors,
  UploadedFile,
  Res,
  StreamableFile,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiParam,
  ApiQuery,
  ApiBearerAuth,
  ApiConsumes,
  ApiBody,
} from '@nestjs/swagger';
import { FileInterceptor } from '@nestjs/platform-express';
import { Response } from 'express';
import * as fs from 'fs';
import { MemberService } from './member.service';
import { SignatureService } from './services/signature.service';
import {
  CreateMemberDto,
  UpdateMemberDto,
  MemberResponseDto,
  SearchMemberDto,
} from './dto';
import { signatureUploadConfig } from './config/multer.config';

@ApiTags('Members')
@Controller('members')
@ApiBearerAuth()
export class MemberController {
  constructor(
    private readonly memberService: MemberService,
    private readonly signatureService: SignatureService,
  ) {}

  @Post()
  @ApiOperation({ summary: 'Create a new member' })
  @ApiResponse({
    status: 201,
    description: 'Member created successfully',
    type: MemberResponseDto,
  })
  @ApiResponse({ status: 400, description: 'Bad request - validation failed' })
  @ApiResponse({ status: 409, description: 'Conflict - duplicate data' })
  async create(@Body() createMemberDto: CreateMemberDto): Promise<MemberResponseDto> {
    return this.memberService.create(createMemberDto);
  }

  @Get('lookup')
  @ApiOperation({ summary: 'Lookup members for loan application' })
  @ApiQuery({ name: 'search', required: false, type: 'string', description: 'Search term' })
  @ApiQuery({ name: 'limit', required: false, type: 'number', description: 'Number of results (default: 500, max: 1000)' })
  @ApiQuery({ name: 'offset', required: false, type: 'number', description: 'Offset for pagination (default: 0)' })
  @ApiResponse({
    status: 200,
    description: 'Members retrieved successfully',
  })
  async lookupMembers(
    @Query('search') search?: string,
    @Query('limit') limit?: number,
    @Query('offset') offset?: number
  ) {
    try {
      return await this.memberService.lookupMembers(search, limit, offset);
    } catch (error) {
      console.error('Error in lookupMembers:', error);
      // Return empty array on error for now
      return [];
    }
  }

  @Get(':memberNo/loan-cases')
  @ApiOperation({ summary: 'Get existing loan cases for a member' })
  @ApiParam({ name: 'memberNo', type: 'string', description: 'Member number' })
  @ApiResponse({
    status: 200,
    description: 'Member loan cases retrieved successfully',
  })
  async getMemberLoanCases(@Param('memberNo') memberNo: string) {
    try {
      return await this.memberService.getMemberLoanCases(memberNo);
    } catch (error) {
      console.error('Error in getMemberLoanCases:', error);
      return [];
    }
  }

  @Get('details/:memberNo')
  @ApiOperation({ summary: 'Get member details by member number' })
  @ApiParam({ name: 'memberNo', type: 'string', description: 'Member number' })
  @ApiResponse({
    status: 200,
    description: 'Member details retrieved successfully',
  })
  async getMemberDetails(@Param('memberNo') memberNo: string) {
    try {
      const memberDetails = await this.memberService.getMemberDetailsByNumber(memberNo);
      if (!memberDetails) {
        throw new Error('Member not found');
      }
      return memberDetails;
    } catch (error) {
      console.error('Error getting member details:', error);
      throw error;
    }
  }

  @Get('balance/:memberNo')
  @ApiOperation({ summary: 'Get member balance information' })
  @ApiParam({ name: 'memberNo', type: 'string', description: 'Member number' })
  @ApiResponse({
    status: 200,
    description: 'Member balance retrieved successfully',
  })
  async getMemberBalance(@Param('memberNo') memberNo: string) {
    try {
      const balanceData = await this.memberService.getMemberBalance(memberNo);
      return balanceData;
    } catch (error) {
      console.error('Error getting member balance:', error);
      throw error;
    }
  }

  @Post('save-member')
  @ApiOperation({ summary: 'Save or update member' })
  @ApiResponse({
    status: 201,
    description: 'Member saved successfully',
  })
  async saveMember(@Body() memberData: any) {
    try {
      console.log('Received member data:', JSON.stringify(memberData, null, 2));
      return await this.memberService.saveMemberMaster(memberData);
    } catch (error) {
      console.error('Error saving member in controller:', error);
      throw error;
    }
  }

  @Get('generate/member-number')
  @ApiOperation({ summary: 'Generate next sequential member number (8 digits)' })
  @ApiResponse({
    status: 200,
    description: 'Member number generated successfully',
    schema: {
      type: 'object',
      properties: {
        memberNumber: { type: 'string', example: '10000001' }
      }
    }
  })
  async generateMemberNumber() {
    try {
      const memberNumber = await this.memberService.generateNextMemberNumber();
      return { memberNumber };
    } catch (error) {
      console.error('Error generating member number:', error);
      throw new Error('Failed to generate member number');
    }
  }

  @Get('generate/loan-case-number')
  @ApiOperation({ summary: 'Generate next sequential loan case number' })
  @ApiResponse({
    status: 200,
    description: 'Loan case number generated successfully',
    schema: {
      type: 'object',
      properties: {
        loanCaseNo: { type: 'string', example: '10001' }
      }
    }
  })
  async generateLoanCaseNumber() {
    try {
      const loanCaseNo = await this.memberService.generateNextLoanCaseNo();
      return { loanCaseNo };
    } catch (error) {
      console.error('Error generating loan case number:', error);
      throw new Error('Failed to generate loan case number');
    }
  }

  @Post('loan-application')
  @ApiOperation({ summary: 'Save loan application' })
  @ApiResponse({
    status: 201,
    description: 'Loan application saved successfully',
  })
  async saveLoanApplication(@Body() loanData: any) {
    try {
      console.log('Received loan application data:', JSON.stringify(loanData, null, 2));
      return await this.memberService.saveLoanApplication(loanData);
    } catch (error) {
      console.error('Error saving loan application in controller:', error);
      console.error('Error stack:', error.stack);
      throw error;
    }
  }

  @Get('loans/pending')
  @ApiOperation({ summary: 'Get all loan cases' })
  @ApiResponse({
    status: 200,
    description: 'Loan cases retrieved successfully',
  })
  async getAllLoanCases() {
    try {
      return await this.memberService.getAllLoanCases();
    } catch (error) {
      console.error('Error getting loan cases:', error);
      return [];
    }
  }

  @Get('loans/case/:caseNo')
  @ApiOperation({ summary: 'Get loan details by case number' })
  @ApiParam({ name: 'caseNo', type: 'string', description: 'Loan case number' })
  @ApiResponse({
    status: 200,
    description: 'Loan details retrieved successfully',
  })
  async getLoanDetailsByCaseNo(@Param('caseNo') caseNo: string) {
    try {
      const loanDetails = await this.memberService.getLoanDetailsByCaseNo(caseNo);
      if (!loanDetails) {
        throw new Error('Loan case not found');
      }
      return loanDetails;
    } catch (error) {
      console.error('Error getting loan details:', error);
      throw error;
    }
  }

  @Patch('loans/sanction/:caseNo')
  @ApiOperation({ summary: 'Update loan with sanction details' })
  @ApiParam({ name: 'caseNo', type: 'string', description: 'Loan case number' })
  @ApiResponse({
    status: 200,
    description: 'Loan sanctioned successfully',
  })
  async updateLoanSanction(
    @Param('caseNo') caseNo: string,
    @Body() sanctionData: any
  ) {
    try {
      console.log('Sanctioning loan:', caseNo, sanctionData);
      return await this.memberService.updateLoanSanction(caseNo, sanctionData);
    } catch (error) {
      console.error('Error sanctioning loan:', error);
      throw error;
    }
  }

  @Post('vouchers/generate')
  @ApiOperation({ summary: 'Generate voucher for loan disbursement (Step 3)' })
  @ApiResponse({
    status: 201,
    description: 'Voucher generated successfully',
  })
  async generateLoanVoucher(@Body() voucherData: any) {
    try {
      console.log('📄 Generating loan voucher:', voucherData);
      return await this.memberService.generateLoanVoucher(voucherData);
    } catch (error) {
      console.error('❌ Error generating voucher:', error);
      throw error;
    }
  }

  @Get('vouchers/pending')
  @ApiOperation({ summary: 'Get all pending vouchers for Pass Transaction (Step 4)' })
  @ApiResponse({
    status: 200,
    description: 'Pending vouchers retrieved successfully',
  })
  async getPendingVouchers() {
    try {
      console.log('📋 Fetching pending vouchers...');
      return await this.memberService.getPendingVouchers();
    } catch (error) {
      console.error('❌ Error fetching pending vouchers:', error);
      throw error;
    }
  }

  @Post('vouchers/pass/:voucherNo')
  @ApiOperation({ summary: 'Pass Transaction - Final Posting (Step 4) - IRREVERSIBLE' })
  @ApiParam({ name: 'voucherNo', type: 'string', description: 'Voucher number to post' })
  @ApiResponse({
    status: 201,
    description: 'Transaction posted successfully to permanent ledger',
  })
  async passTransaction(
    @Param('voucherNo') voucherNo: string,
    @Body() postData: { postedBy?: string }
  ) {
    try {
      console.log(`🔒 Posting transaction for voucher: ${voucherNo}`);
      return await this.memberService.passTransaction(voucherNo, postData.postedBy || 'admin');
    } catch (error) {
      console.error('❌ Error posting transaction:', error);
      throw error;
    }
  }

  @Get()
  @ApiOperation({ summary: 'Get all members with search and pagination' })
  @ApiResponse({
    status: 200,
    description: 'Members retrieved successfully',
  })
  @ApiQuery({ name: 'page', required: false, type: Number, description: 'Page number' })
  @ApiQuery({ name: 'limit', required: false, type: Number, description: 'Items per page' })
  @ApiQuery({ name: 'search', required: false, type: String, description: 'General search term' })
  @ApiQuery({ name: 'memberNumber', required: false, type: String, description: 'Filter by member number' })
  @ApiQuery({ name: 'firstName', required: false, type: String, description: 'Filter by first name' })
  @ApiQuery({ name: 'lastName', required: false, type: String, description: 'Filter by last name' })
  @ApiQuery({ name: 'phoneNumber', required: false, type: String, description: 'Filter by phone number' })
  @ApiQuery({ name: 'email', required: false, type: String, description: 'Filter by email' })
  @ApiQuery({ name: 'status', required: false, enum: ['ACTIVE', 'INACTIVE', 'SUSPENDED'], description: 'Filter by status' })
  @ApiQuery({ name: 'sortBy', required: false, enum: ['memberNumber', 'firstName', 'lastName', 'createdAt', 'updatedAt'], description: 'Sort field' })
  @ApiQuery({ name: 'sortOrder', required: false, enum: ['ASC', 'DESC'], description: 'Sort order' })
  async findAll(@Query() searchDto: SearchMemberDto) {
    return this.memberService.findAll(searchDto);
  }

  @Get('statistics')
  @ApiOperation({ summary: 'Get member statistics' })
  @ApiResponse({
    status: 200,
    description: 'Member statistics retrieved successfully',
  })
  async getStatistics() {
    return this.memberService.getStatistics();
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get member by ID' })
  @ApiParam({ name: 'id', type: 'number', description: 'Member ID' })
  @ApiResponse({
    status: 200,
    description: 'Member retrieved successfully',
    type: MemberResponseDto,
  })
  @ApiResponse({ status: 404, description: 'Member not found' })
  async findOne(@Param('id', ParseIntPipe) id: number): Promise<MemberResponseDto> {
    return this.memberService.findOne(id);
  }

  @Get('member-number/:memberNumber')
  @ApiOperation({ summary: 'Get member by member number' })
  @ApiParam({ name: 'memberNumber', type: 'string', description: 'Member number' })
  @ApiResponse({
    status: 200,
    description: 'Member retrieved successfully',
    type: MemberResponseDto,
  })
  @ApiResponse({ status: 404, description: 'Member not found' })
  async findByMemberNumber(@Param('memberNumber') memberNumber: string): Promise<MemberResponseDto> {
    return this.memberService.findByMemberNumber(memberNumber);
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Update member by ID' })
  @ApiParam({ name: 'id', type: 'number', description: 'Member ID' })
  @ApiResponse({
    status: 200,
    description: 'Member updated successfully',
    type: MemberResponseDto,
  })
  @ApiResponse({ status: 400, description: 'Bad request - validation failed' })
  @ApiResponse({ status: 404, description: 'Member not found' })
  @ApiResponse({ status: 409, description: 'Conflict - duplicate data' })
  async update(
    @Param('id', ParseIntPipe) id: number,
    @Body() updateMemberDto: UpdateMemberDto,
  ): Promise<MemberResponseDto> {
    return this.memberService.update(id, updateMemberDto);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Soft delete member by ID' })
  @ApiParam({ name: 'id', type: 'number', description: 'Member ID' })
  @ApiResponse({ status: 204, description: 'Member deleted successfully' })
  @ApiResponse({ status: 404, description: 'Member not found' })
  async remove(@Param('id', ParseIntPipe) id: number): Promise<void> {
    return this.memberService.remove(id);
  }

  @Post(':id/restore')
  @ApiOperation({ summary: 'Restore soft deleted member' })
  @ApiParam({ name: 'id', type: 'number', description: 'Member ID' })
  @ApiResponse({
    status: 200,
    description: 'Member restored successfully',
    type: MemberResponseDto,
  })
  @ApiResponse({ status: 400, description: 'Member is not deleted' })
  @ApiResponse({ status: 404, description: 'Member not found' })
  async restore(@Param('id', ParseIntPipe) id: number): Promise<MemberResponseDto> {
    return this.memberService.restore(id);
  }

  @Post(':id/signature')
  @UseInterceptors(FileInterceptor('signature', signatureUploadConfig))
  @ApiOperation({ summary: 'Upload member signature' })
  @ApiConsumes('multipart/form-data')
  @ApiParam({ name: 'id', type: 'number', description: 'Member ID' })
  @ApiBody({
    description: 'Signature image file',
    schema: {
      type: 'object',
      properties: {
        signature: {
          type: 'string',
          format: 'binary',
          description: 'Signature image (JPEG/PNG, max 2MB)',
        },
      },
    },
  })
  @ApiResponse({
    status: 201,
    description: 'Signature uploaded successfully',
    schema: {
      type: 'object',
      properties: {
        signatureUrl: {
          type: 'string',
          example: '/api/v1/members/1/signature',
        },
      },
    },
  })
  @ApiResponse({ status: 400, description: 'Bad request - invalid file' })
  @ApiResponse({ status: 404, description: 'Member not found' })
  async uploadSignature(
    @Param('id', ParseIntPipe) id: number,
    @UploadedFile() file: Express.Multer.File,
  ) {
    return this.signatureService.uploadSignature(id, file);
  }

  @Get(':id/signature')
  @ApiOperation({ summary: 'Get member signature image' })
  @ApiParam({ name: 'id', type: 'number', description: 'Member ID' })
  @ApiResponse({
    status: 200,
    description: 'Signature image retrieved successfully',
    content: {
      'image/jpeg': {
        schema: {
          type: 'string',
          format: 'binary',
        },
      },
      'image/png': {
        schema: {
          type: 'string',
          format: 'binary',
        },
      },
    },
  })
  @ApiResponse({ status: 404, description: 'Member or signature not found' })
  async getSignature(
    @Param('id', ParseIntPipe) id: number,
    @Res({ passthrough: true }) res: Response,
  ): Promise<StreamableFile> {
    const { filePath, mimeType } = await this.signatureService.getSignature(id);
    
    const file = fs.createReadStream(filePath);
    res.set({
      'Content-Type': mimeType,
      'Content-Disposition': `inline; filename="member_${id}_signature"`,
    });
    
    return new StreamableFile(file);
  }

  @Delete(':id/signature')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Delete member signature' })
  @ApiParam({ name: 'id', type: 'number', description: 'Member ID' })
  @ApiResponse({ status: 204, description: 'Signature deleted successfully' })
  @ApiResponse({ status: 404, description: 'Member or signature not found' })
  async deleteSignature(@Param('id', ParseIntPipe) id: number): Promise<void> {
    return this.signatureService.deleteSignature(id);
  }

  @Get('signatures/statistics')
  @ApiOperation({ summary: 'Get signature statistics' })
  @ApiResponse({
    status: 200,
    description: 'Signature statistics retrieved successfully',
    schema: {
      type: 'object',
      properties: {
        totalMembers: { type: 'number' },
        membersWithSignature: { type: 'number' },
        membersWithoutSignature: { type: 'number' },
        signaturePercentage: { type: 'number' },
      },
    },
  })
  async getSignatureStatistics() {
    return this.signatureService.getSignatureStatistics();
  }
}
