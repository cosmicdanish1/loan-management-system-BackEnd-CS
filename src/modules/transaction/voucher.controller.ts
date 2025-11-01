import {
  Controller,
  Post,
  Body,
  UseGuards,
  HttpStatus,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBearerAuth,
} from '@nestjs/swagger';
import { TransactionService } from './transaction.service';
import {
  CreateVoucherDto,
  VoucherResponseDto,
} from './dto';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RoleGuard } from '../auth/guards/role.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { UserRole } from '../auth/entities/user.entity';

@ApiTags('Vouchers')
@Controller('vouchers')
@UseGuards(JwtAuthGuard)
@ApiBearerAuth()
export class VoucherController {
  constructor(private readonly transactionService: TransactionService) {}

  @Post()
  @UseGuards(RoleGuard)
  @Roles(UserRole.ADMIN, UserRole.MANAGER, UserRole.ACCOUNTANT)
  @ApiOperation({ summary: 'Create a new voucher with multiple transactions' })
  @ApiResponse({
    status: HttpStatus.CREATED,
    description: 'Voucher created successfully',
    type: VoucherResponseDto,
  })
  @ApiResponse({
    status: HttpStatus.BAD_REQUEST,
    description: 'Invalid voucher data or double-entry validation failed',
  })
  async createVoucher(
    @Body() createVoucherDto: CreateVoucherDto,
  ): Promise<VoucherResponseDto> {
    return this.transactionService.createVoucher(createVoucherDto);
  }
}
