import {
  Controller,
  Post,
  Put,
  Param,
  Body,
  ParseIntPipe,
  UseGuards,
  HttpStatus,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiParam,
  ApiBearerAuth,
} from '@nestjs/swagger';
import { PaymentService } from './services/payment.service';
import {
  CreatePaymentVoucherDto,
  CreateReceiptVoucherDto,
  CreateBalanceTransferDto,
  RollbackTransactionDto,
} from './dto';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RoleGuard } from '../auth/guards/role.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { UserRole } from '../auth/entities/user.entity';

@ApiTags('Payments & Receipts')
@Controller('payments')
@UseGuards(JwtAuthGuard)
@ApiBearerAuth()
export class PaymentController {
  constructor(private readonly paymentService: PaymentService) {}

  @Post('vouchers')
  @UseGuards(RoleGuard)
  @Roles(UserRole.ADMIN, UserRole.MANAGER, UserRole.ACCOUNTANT)
  @ApiOperation({ summary: 'Create a payment voucher' })
  @ApiResponse({
    status: HttpStatus.CREATED,
    description: 'Payment voucher created successfully',
  })
  @ApiResponse({
    status: HttpStatus.BAD_REQUEST,
    description: 'Invalid payment data',
  })
  async createPaymentVoucher(
    @Body() createPaymentDto: CreatePaymentVoucherDto,
  ) {
    return this.paymentService.createPaymentVoucher(createPaymentDto);
  }

  @Post('receipts')
  @UseGuards(RoleGuard)
  @Roles(UserRole.ADMIN, UserRole.MANAGER, UserRole.ACCOUNTANT)
  @ApiOperation({ summary: 'Create a receipt voucher' })
  @ApiResponse({
    status: HttpStatus.CREATED,
    description: 'Receipt voucher created successfully',
  })
  @ApiResponse({
    status: HttpStatus.BAD_REQUEST,
    description: 'Invalid receipt data',
  })
  @ApiResponse({
    status: HttpStatus.NOT_FOUND,
    description: 'Member not found',
  })
  async createReceiptVoucher(
    @Body() createReceiptDto: CreateReceiptVoucherDto,
  ) {
    return this.paymentService.createReceiptVoucher(createReceiptDto);
  }

  @Post('transfers')
  @UseGuards(RoleGuard)
  @Roles(UserRole.ADMIN, UserRole.MANAGER)
  @ApiOperation({ summary: 'Create a member balance transfer' })
  @ApiResponse({
    status: HttpStatus.CREATED,
    description: 'Balance transfer created successfully',
  })
  @ApiResponse({
    status: HttpStatus.BAD_REQUEST,
    description: 'Invalid transfer data',
  })
  @ApiResponse({
    status: HttpStatus.NOT_FOUND,
    description: 'One or both members not found',
  })
  async createBalanceTransfer(
    @Body() createTransferDto: CreateBalanceTransferDto,
  ) {
    return this.paymentService.createMemberBalanceTransfer(createTransferDto);
  }

  @Put('transactions/:id/rollback')
  @UseGuards(RoleGuard)
  @Roles(UserRole.ADMIN, UserRole.MANAGER)
  @ApiOperation({ summary: 'Rollback a transaction' })
  @ApiParam({ name: 'id', description: 'Transaction ID to rollback' })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'Transaction rolled back successfully',
  })
  @ApiResponse({
    status: HttpStatus.NOT_FOUND,
    description: 'Transaction not found',
  })
  @ApiResponse({
    status: HttpStatus.BAD_REQUEST,
    description: 'Transaction cannot be rolled back',
  })
  async rollbackTransaction(
    @Param('id', ParseIntPipe) id: number,
    @Body() rollbackDto: RollbackTransactionDto,
  ) {
    return this.paymentService.rollbackTransaction(id, rollbackDto.reason);
  }
}
