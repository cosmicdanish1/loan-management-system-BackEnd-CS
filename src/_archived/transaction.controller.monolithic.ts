import {
  Controller,
  Get,
  Post,
  Put,
  Param,
  Body,
  Query,
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
import { TransactionService } from './transaction.service';
import {
  CreateTransactionDto,
  TransactionQueryDto,
  ReverseTransactionDto,
  TransactionResponseDto,
} from './dto';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RoleGuard } from '../auth/guards/role.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { UserRole } from '../auth/entities/user.entity';

@ApiTags('Transactions')
@Controller('transactions')
@UseGuards(JwtAuthGuard)
@ApiBearerAuth()
export class TransactionController {
  constructor(private readonly transactionService: TransactionService) {}

  @Post()
  @UseGuards(RoleGuard)
  @Roles(UserRole.ADMIN, UserRole.MANAGER, UserRole.ACCOUNTANT)
  @ApiOperation({ summary: 'Create a new transaction' })
  @ApiResponse({
    status: HttpStatus.CREATED,
    description: 'Transaction created successfully',
    type: TransactionResponseDto,
  })
  @ApiResponse({
    status: HttpStatus.BAD_REQUEST,
    description: 'Invalid transaction data or double-entry validation failed',
  })
  async createTransaction(
    @Body() createTransactionDto: CreateTransactionDto,
  ): Promise<TransactionResponseDto> {
    return this.transactionService.createTransaction(createTransactionDto);
  }

  @Get()
  @UseGuards(RoleGuard)
  @Roles(UserRole.ADMIN, UserRole.MANAGER, UserRole.ACCOUNTANT, UserRole.DATA_OPERATOR)
  @ApiOperation({ summary: 'Get all transactions with filtering and pagination' })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'Transactions retrieved successfully',
  })
  async findAllTransactions(@Query() query: TransactionQueryDto) {
    return this.transactionService.findAllTransactions(query);
  }

  @Get(':id')
  @UseGuards(RoleGuard)
  @Roles(UserRole.ADMIN, UserRole.MANAGER, UserRole.ACCOUNTANT, UserRole.DATA_OPERATOR)
  @ApiOperation({ summary: 'Get transaction by ID' })
  @ApiParam({ name: 'id', description: 'Transaction ID' })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'Transaction retrieved successfully',
    type: TransactionResponseDto,
  })
  @ApiResponse({
    status: HttpStatus.NOT_FOUND,
    description: 'Transaction not found',
  })
  async findTransactionById(
    @Param('id', ParseIntPipe) id: number,
  ): Promise<TransactionResponseDto> {
    return this.transactionService.findTransactionById(id);
  }

  @Put(':id/reverse')
  @UseGuards(RoleGuard)
  @Roles(UserRole.ADMIN, UserRole.MANAGER)
  @ApiOperation({ summary: 'Reverse a transaction' })
  @ApiParam({ name: 'id', description: 'Transaction ID to reverse' })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'Transaction reversed successfully',
    type: TransactionResponseDto,
  })
  @ApiResponse({
    status: HttpStatus.NOT_FOUND,
    description: 'Transaction not found',
  })
  @ApiResponse({
    status: HttpStatus.BAD_REQUEST,
    description: 'Transaction cannot be reversed',
  })
  async reverseTransaction(
    @Param('id', ParseIntPipe) id: number,
    @Body() reverseDto: ReverseTransactionDto,
  ): Promise<TransactionResponseDto> {
    return this.transactionService.reverseTransaction(id, reverseDto);
  }
}
