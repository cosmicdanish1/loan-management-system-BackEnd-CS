import {
  Controller,
  Get,
  Post,
  Put,
  Patch,
  Param,
  Body,
  Query,
  ParseIntPipe,
  UseGuards,
  HttpStatus,
  Res,
  StreamableFile,
  NotFoundException,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiParam,
  ApiQuery,
  ApiBearerAuth,
} from '@nestjs/swagger';
import { Response } from 'express';
import * as fs from 'fs';
import { DepositService } from './deposit.service';
import { CertificateService } from './services';
import { JwtAuthGuard, RoleGuard } from '../auth/guards';
import { Roles } from '../auth/decorators/roles.decorator';
import { UserRole } from '../auth/entities/user.entity';
import {
  CreateFixedDepositDto,
  UpdateFixedDepositDto,
  FixedDepositResponseDto,
  CreateRecurringDepositDto,
  UpdateRecurringDepositDto,
  RecurringDepositResponseDto,
  DepositClosureDto,
  DepositMaturityDto,
  PayRdInstallmentDto,
  RdInstallmentResponseDto,
} from './dto';

@ApiTags('Deposits')
@Controller('deposits')
@UseGuards(JwtAuthGuard, RoleGuard)
@ApiBearerAuth()
export class DepositController {
  constructor(
    private readonly depositService: DepositService,
    private readonly certificateService: CertificateService,
  ) {}

  // Fixed Deposit Endpoints
  @Post('fixed-deposits')
  @Roles(UserRole.ADMIN, UserRole.MANAGER, UserRole.LOAN_OFFICER)
  @ApiOperation({ summary: 'Create a new fixed deposit' })
  @ApiResponse({
    status: HttpStatus.CREATED,
    description: 'Fixed deposit created successfully',
    type: FixedDepositResponseDto,
  })
  async createFixedDeposit(@Body() createFixedDepositDto: CreateFixedDepositDto) {
    return await this.depositService.createFixedDeposit(createFixedDepositDto);
  }

  @Get('fixed-deposits')
  @Roles(UserRole.ADMIN, UserRole.MANAGER, UserRole.LOAN_OFFICER, UserRole.ACCOUNTANT)
  @ApiOperation({ summary: 'Get all fixed deposits' })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'List of fixed deposits',
    type: [FixedDepositResponseDto],
  })
  async findAllFixedDeposits() {
    return await this.depositService.findAllFixedDeposits();
  }

  @Get('fixed-deposits/:id')
  @Roles(UserRole.ADMIN, UserRole.MANAGER, UserRole.LOAN_OFFICER, UserRole.ACCOUNTANT)
  @ApiOperation({ summary: 'Get fixed deposit by ID' })
  @ApiParam({ name: 'id', description: 'Fixed deposit ID' })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'Fixed deposit details',
    type: FixedDepositResponseDto,
  })
  async findFixedDepositById(@Param('id', ParseIntPipe) id: number) {
    return await this.depositService.findFixedDepositById(id);
  }

  @Get('members/:memberId/fixed-deposits')
  @Roles(UserRole.ADMIN, UserRole.MANAGER, UserRole.LOAN_OFFICER, UserRole.ACCOUNTANT)
  @ApiOperation({ summary: 'Get fixed deposits by member ID' })
  @ApiParam({ name: 'memberId', description: 'Member ID' })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'Member fixed deposits',
    type: [FixedDepositResponseDto],
  })
  async findFixedDepositsByMember(@Param('memberId', ParseIntPipe) memberId: number) {
    return await this.depositService.findFixedDepositsByMember(memberId);
  }

  @Put('fixed-deposits/:id')
  @Roles(UserRole.ADMIN, UserRole.MANAGER)
  @ApiOperation({ summary: 'Update fixed deposit' })
  @ApiParam({ name: 'id', description: 'Fixed deposit ID' })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'Fixed deposit updated successfully',
    type: FixedDepositResponseDto,
  })
  async updateFixedDeposit(
    @Param('id', ParseIntPipe) id: number,
    @Body() updateFixedDepositDto: UpdateFixedDepositDto,
  ) {
    return await this.depositService.updateFixedDeposit(id, updateFixedDepositDto);
  }

  @Patch('fixed-deposits/:id/close')
  @Roles(UserRole.ADMIN, UserRole.MANAGER)
  @ApiOperation({ summary: 'Close fixed deposit' })
  @ApiParam({ name: 'id', description: 'Fixed deposit ID' })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'Fixed deposit closed successfully',
    type: FixedDepositResponseDto,
  })
  async closeFixedDeposit(
    @Param('id', ParseIntPipe) id: number,
    @Body() closureDto: DepositClosureDto,
  ) {
    return await this.depositService.closeFixedDeposit(id, closureDto);
  }

  @Patch('fixed-deposits/:id/maturity')
  @Roles(UserRole.ADMIN, UserRole.MANAGER)
  @ApiOperation({ summary: 'Process fixed deposit maturity' })
  @ApiParam({ name: 'id', description: 'Fixed deposit ID' })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'Fixed deposit maturity processed successfully',
    type: FixedDepositResponseDto,
  })
  async processFixedDepositMaturity(
    @Param('id', ParseIntPipe) id: number,
    @Body() maturityDto: DepositMaturityDto,
  ) {
    return await this.depositService.processFixedDepositMaturity(id, maturityDto);
  }

  // Recurring Deposit Endpoints
  @Post('recurring-deposits')
  @Roles(UserRole.ADMIN, UserRole.MANAGER, UserRole.LOAN_OFFICER)
  @ApiOperation({ summary: 'Create a new recurring deposit' })
  @ApiResponse({
    status: HttpStatus.CREATED,
    description: 'Recurring deposit created successfully',
    type: RecurringDepositResponseDto,
  })
  async createRecurringDeposit(@Body() createRecurringDepositDto: CreateRecurringDepositDto) {
    return await this.depositService.createRecurringDeposit(createRecurringDepositDto);
  }

  @Get('recurring-deposits')
  @Roles(UserRole.ADMIN, UserRole.MANAGER, UserRole.LOAN_OFFICER, UserRole.ACCOUNTANT)
  @ApiOperation({ summary: 'Get all recurring deposits' })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'List of recurring deposits',
    type: [RecurringDepositResponseDto],
  })
  async findAllRecurringDeposits() {
    return await this.depositService.findAllRecurringDeposits();
  }

  @Get('recurring-deposits/:id')
  @Roles(UserRole.ADMIN, UserRole.MANAGER, UserRole.LOAN_OFFICER, UserRole.ACCOUNTANT)
  @ApiOperation({ summary: 'Get recurring deposit by ID' })
  @ApiParam({ name: 'id', description: 'Recurring deposit ID' })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'Recurring deposit details',
    type: RecurringDepositResponseDto,
  })
  async findRecurringDepositById(@Param('id', ParseIntPipe) id: number) {
    return await this.depositService.findRecurringDepositById(id);
  }

  @Get('members/:memberId/recurring-deposits')
  @Roles(UserRole.ADMIN, UserRole.MANAGER, UserRole.LOAN_OFFICER, UserRole.ACCOUNTANT)
  @ApiOperation({ summary: 'Get recurring deposits by member ID' })
  @ApiParam({ name: 'memberId', description: 'Member ID' })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'Member recurring deposits',
    type: [RecurringDepositResponseDto],
  })
  async findRecurringDepositsByMember(@Param('memberId', ParseIntPipe) memberId: number) {
    return await this.depositService.findRecurringDepositsByMember(memberId);
  }

  @Patch('recurring-deposits/:id/close')
  @Roles(UserRole.ADMIN, UserRole.MANAGER)
  @ApiOperation({ summary: 'Close recurring deposit' })
  @ApiParam({ name: 'id', description: 'Recurring deposit ID' })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'Recurring deposit closed successfully',
    type: RecurringDepositResponseDto,
  })
  async closeRecurringDeposit(
    @Param('id', ParseIntPipe) id: number,
    @Body() closureDto: DepositClosureDto,
  ) {
    return await this.depositService.closeRecurringDeposit(id, closureDto);
  }

  // RD Installment Endpoints
  @Patch('rd-installments/:id/pay')
  @Roles(UserRole.ADMIN, UserRole.MANAGER, UserRole.LOAN_OFFICER)
  @ApiOperation({ summary: 'Pay RD installment' })
  @ApiParam({ name: 'id', description: 'RD installment ID' })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'RD installment paid successfully',
    type: RdInstallmentResponseDto,
  })
  async payRdInstallment(
    @Param('id', ParseIntPipe) id: number,
    @Body() paymentDto: PayRdInstallmentDto,
  ) {
    return await this.depositService.payRdInstallment(id, paymentDto);
  }

  // Certificate Endpoints
  @Post('fixed-deposits/:id/certificate')
  @Roles(UserRole.ADMIN, UserRole.MANAGER, UserRole.LOAN_OFFICER)
  @ApiOperation({ summary: 'Generate fixed deposit certificate' })
  @ApiParam({ name: 'id', description: 'Fixed deposit ID' })
  @ApiResponse({
    status: HttpStatus.CREATED,
    description: 'Certificate generated successfully',
  })
  async generateFixedDepositCertificate(@Param('id', ParseIntPipe) id: number) {
    const fileName = await this.certificateService.generateFixedDepositCertificate(id);
    return { 
      message: 'Certificate generated successfully',
      fileName,
      downloadUrl: `/api/v1/deposits/certificates/download/${fileName}`
    };
  }

  @Post('recurring-deposits/:id/certificate')
  @Roles(UserRole.ADMIN, UserRole.MANAGER, UserRole.LOAN_OFFICER)
  @ApiOperation({ summary: 'Generate recurring deposit certificate' })
  @ApiParam({ name: 'id', description: 'Recurring deposit ID' })
  @ApiResponse({
    status: HttpStatus.CREATED,
    description: 'Certificate generated successfully',
  })
  async generateRecurringDepositCertificate(@Param('id', ParseIntPipe) id: number) {
    const fileName = await this.certificateService.generateRecurringDepositCertificate(id);
    return { 
      message: 'Certificate generated successfully',
      fileName,
      downloadUrl: `/api/v1/deposits/certificates/download/${fileName}`
    };
  }

  @Post('members/:memberId/share-certificate')
  @Roles(UserRole.ADMIN, UserRole.MANAGER, UserRole.LOAN_OFFICER)
  @ApiOperation({ summary: 'Generate share certificate for member' })
  @ApiParam({ name: 'memberId', description: 'Member ID' })
  @ApiResponse({
    status: HttpStatus.CREATED,
    description: 'Share certificate generated successfully',
  })
  async generateShareCertificate(
    @Param('memberId', ParseIntPipe) memberId: number,
    @Body() body: { shareAmount: number },
  ) {
    const fileName = await this.certificateService.generateShareCertificate(memberId, body.shareAmount);
    return { 
      message: 'Share certificate generated successfully',
      fileName,
      downloadUrl: `/api/v1/deposits/certificates/download/${fileName}`
    };
  }

  @Get('certificates/download/:fileName')
  @Roles(UserRole.ADMIN, UserRole.MANAGER, UserRole.LOAN_OFFICER, UserRole.ACCOUNTANT)
  @ApiOperation({ summary: 'Download certificate file' })
  @ApiParam({ name: 'fileName', description: 'Certificate file name' })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'Certificate file download',
  })
  async downloadCertificate(
    @Param('fileName') fileName: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<StreamableFile> {
    const filePath = this.certificateService.getCertificateFilePath(fileName);
    
    if (!fs.existsSync(filePath)) {
      throw new NotFoundException('Certificate file not found');
    }

    const file = fs.createReadStream(filePath);
    
    res.set({
      'Content-Type': 'application/pdf',
      'Content-Disposition': `attachment; filename="${fileName}"`,
    });

    return new StreamableFile(file);
  }

  // Utility Endpoints
  @Post('calculate-interest')
  @Roles(UserRole.ADMIN, UserRole.MANAGER)
  @ApiOperation({ summary: 'Calculate and post interest for all deposits' })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'Interest calculation completed',
  })
  async calculateAndPostInterest() {
    await this.depositService.calculateAndPostInterest();
    return { message: 'Interest calculation completed successfully' };
  }
}
