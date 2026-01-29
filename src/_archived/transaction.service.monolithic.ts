import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ConflictException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, DataSource, QueryRunner } from 'typeorm';
import { Transaction, Voucher } from './entities';
import {
  CreateTransactionDto,
  CreateVoucherDto,
  UpdateTransactionDto,
  TransactionQueryDto,
  ReverseTransactionDto,
  TransactionResponseDto,
  VoucherResponseDto,
} from './dto';
import { plainToClass } from 'class-transformer';

import { SequenceGeneratorService } from '../shared/services/sequence-generator.service';

@Injectable()
export class TransactionService {
  constructor(
    @InjectRepository(Transaction)
    private transactionRepository: Repository<Transaction>,
    @InjectRepository(Voucher)
    private voucherRepository: Repository<Voucher>,
    private dataSource: DataSource,
    private sequenceGenerator: SequenceGeneratorService,
  ) { }

  async createTransaction(createTransactionDto: CreateTransactionDto): Promise<TransactionResponseDto> {
    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();

    try {
      // Validate double-entry bookkeeping
      this.validateDoubleEntry(createTransactionDto);

      // Generate unique transaction number
      const transactionNumber = await this.generateTransactionNumber(queryRunner);

      // Create transaction
      const transaction = queryRunner.manager.create(Transaction, {
        ...createTransactionDto,
        transactionNumber,
        transactionDate: createTransactionDto.transactionDate
          ? new Date(createTransactionDto.transactionDate)
          : new Date(),
        status: 'POSTED',
      });

      const savedTransaction = await queryRunner.manager.save(transaction);
      await queryRunner.commitTransaction();

      return this.mapToResponseDto(savedTransaction);
    } catch (error) {
      await queryRunner.rollbackTransaction();
      throw error;
    } finally {
      await queryRunner.release();
    }
  }

  async createVoucher(createVoucherDto: CreateVoucherDto): Promise<VoucherResponseDto> {
    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();

    try {
      // Validate voucher transactions
      this.validateVoucherTransactions(createVoucherDto);

      // Generate unique voucher number
      const voucherNumber = await this.generateVoucherNumber(queryRunner, createVoucherDto.voucherType);

      // Calculate total amount
      const totalAmount = createVoucherDto.transactions.reduce(
        (sum, txn) => sum + txn.amount,
        0,
      );

      // Create voucher
      const voucher = queryRunner.manager.create(Voucher, {
        ...createVoucherDto,
        voucherNumber,
        totalAmount,
        voucherDate: createVoucherDto.voucherDate
          ? new Date(createVoucherDto.voucherDate)
          : new Date(),
        chequeDate: createVoucherDto.chequeDate
          ? new Date(createVoucherDto.chequeDate)
          : null,
        status: 'ACTIVE',
      });

      const savedVoucher = await queryRunner.manager.save(voucher);

      // Create associated transactions
      const transactions = [];
      for (const txnDto of createVoucherDto.transactions) {
        const transactionNumber = await this.generateTransactionNumber(queryRunner);

        const transaction = queryRunner.manager.create(Transaction, {
          transactionNumber,
          transactionDate: savedVoucher.voucherDate,
          transactionType: this.mapVoucherTypeToTransactionType(createVoucherDto.voucherType),
          amount: txnDto.amount,
          description: txnDto.description,
          debitAccount: txnDto.debitAccount,
          creditAccount: txnDto.creditAccount,
          memberId: createVoucherDto.memberId,
          voucherNumber: savedVoucher.voucherNumber,
          referenceType: txnDto.referenceType,
          referenceId: txnDto.referenceId,
          status: 'POSTED',
        });

        const savedTransaction = await queryRunner.manager.save(transaction);
        transactions.push(savedTransaction);
      }

      await queryRunner.commitTransaction();

      // Load voucher with relations
      const voucherWithRelations = await this.voucherRepository.findOne({
        where: { id: savedVoucher.id },
        relations: ['member', 'transactions'],
      });

      return this.mapVoucherToResponseDto(voucherWithRelations);
    } catch (error) {
      await queryRunner.rollbackTransaction();
      throw error;
    } finally {
      await queryRunner.release();
    }
  }

  async findAllTransactions(query: TransactionQueryDto): Promise<{
    data: TransactionResponseDto[];
    total: number;
    page: number;
    limit: number;
    totalPages: number;
  }> {
    const queryBuilder = this.transactionRepository
      .createQueryBuilder('transaction')
      .leftJoinAndSelect('transaction.member', 'member');

    // Apply filters
    if (query.transactionType) {
      queryBuilder.andWhere('transaction.transactionType = :transactionType', {
        transactionType: query.transactionType,
      });
    }

    if (query.memberId) {
      queryBuilder.andWhere('transaction.memberId = :memberId', {
        memberId: query.memberId,
      });
    }

    if (query.status) {
      queryBuilder.andWhere('transaction.status = :status', {
        status: query.status,
      });
    }

    if (query.voucherNumber) {
      queryBuilder.andWhere('transaction.voucherNumber = :voucherNumber', {
        voucherNumber: query.voucherNumber,
      });
    }

    if (query.referenceType) {
      queryBuilder.andWhere('transaction.referenceType = :referenceType', {
        referenceType: query.referenceType,
      });
    }

    if (query.referenceId) {
      queryBuilder.andWhere('transaction.referenceId = :referenceId', {
        referenceId: query.referenceId,
      });
    }

    if (query.fromDate) {
      queryBuilder.andWhere('transaction.transactionDate >= :fromDate', {
        fromDate: query.fromDate,
      });
    }

    if (query.toDate) {
      queryBuilder.andWhere('transaction.transactionDate <= :toDate', {
        toDate: query.toDate,
      });
    }

    if (query.minAmount) {
      queryBuilder.andWhere('transaction.amount >= :minAmount', {
        minAmount: query.minAmount,
      });
    }

    if (query.maxAmount) {
      queryBuilder.andWhere('transaction.amount <= :maxAmount', {
        maxAmount: query.maxAmount,
      });
    }

    if (query.search) {
      queryBuilder.andWhere(
        'transaction.description ILIKE :search OR transaction.transactionNumber ILIKE :search',
        { search: `%${query.search}%` },
      );
    }

    // Apply sorting
    queryBuilder.orderBy(
      `transaction.${query.sortBy}`,
      query.sortOrder,
    );

    // Apply pagination
    const total = await queryBuilder.getCount();
    const transactions = await queryBuilder
      .skip((query.page - 1) * query.limit)
      .take(query.limit)
      .getMany();

    const totalPages = Math.ceil(total / query.limit);

    return {
      data: transactions.map(transaction => this.mapToResponseDto(transaction)),
      total,
      page: query.page,
      limit: query.limit,
      totalPages,
    };
  }

  async findTransactionById(id: number): Promise<TransactionResponseDto> {
    const transaction = await this.transactionRepository.findOne({
      where: { id },
      relations: ['member'],
    });

    if (!transaction) {
      throw new NotFoundException(`Transaction with ID ${id} not found`);
    }

    return this.mapToResponseDto(transaction);
  }

  async reverseTransaction(id: number, reverseDto: ReverseTransactionDto): Promise<TransactionResponseDto> {
    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();

    try {
      const transaction = await queryRunner.manager.findOne(Transaction, {
        where: { id },
        relations: ['member'],
      });

      if (!transaction) {
        throw new NotFoundException(`Transaction with ID ${id} not found`);
      }

      if (!transaction.canBeReversed) {
        throw new BadRequestException('Transaction cannot be reversed');
      }

      // Create reversal transaction
      const reversalTransactionNumber = await this.generateTransactionNumber(queryRunner);

      const reversalTransaction = queryRunner.manager.create(Transaction, {
        transactionNumber: reversalTransactionNumber,
        transactionDate: new Date(),
        transactionType: transaction.transactionType,
        amount: transaction.amount,
        description: `REVERSAL: ${transaction.description} - ${reverseDto.reason}`,
        debitAccount: transaction.creditAccount, // Swap accounts
        creditAccount: transaction.debitAccount,
        memberId: transaction.memberId,
        voucherNumber: transaction.voucherNumber,
        referenceType: transaction.referenceType,
        referenceId: transaction.referenceId,
        status: 'POSTED',
        remarks: `Reversal of transaction ${transaction.transactionNumber}: ${reverseDto.reason}`,
      });

      const savedReversalTransaction = await queryRunner.manager.save(reversalTransaction);

      // Update original transaction
      transaction.status = 'REVERSED';
      transaction.reversedTransactionId = savedReversalTransaction.id;
      transaction.reversedAt = new Date();
      transaction.remarks = `${transaction.remarks || ''} - REVERSED: ${reverseDto.reason}`.trim();

      await queryRunner.manager.save(transaction);
      await queryRunner.commitTransaction();

      return this.mapToResponseDto(transaction);
    } catch (error) {
      await queryRunner.rollbackTransaction();
      throw error;
    } finally {
      await queryRunner.release();
    }
  }

  private validateDoubleEntry(dto: CreateTransactionDto): void {
    if (dto.debitAccount === dto.creditAccount) {
      throw new BadRequestException('Debit and credit accounts cannot be the same');
    }

    if (dto.amount <= 0) {
      throw new BadRequestException('Transaction amount must be positive');
    }
  }

  private validateVoucherTransactions(dto: CreateVoucherDto): void {
    if (!dto.transactions || dto.transactions.length === 0) {
      throw new BadRequestException('Voucher must have at least one transaction');
    }

    // Validate double-entry for voucher
    let totalDebit = 0;
    let totalCredit = 0;

    for (const txn of dto.transactions) {
      if (txn.debitAccount === txn.creditAccount) {
        throw new BadRequestException('Debit and credit accounts cannot be the same in transaction');
      }

      if (txn.amount <= 0) {
        throw new BadRequestException('All transaction amounts must be positive');
      }

      totalDebit += txn.amount;
      totalCredit += txn.amount;
    }

    // For vouchers, we ensure each transaction is balanced individually
    // The voucher itself represents a collection of balanced transactions
  }

  private async generateTransactionNumber(queryRunner: QueryRunner): Promise<string> {
    const year = new Date().getFullYear();
    return await this.sequenceGenerator.generateSequence(`TXN_NO_${year}`, `TXN${year}`, 6);
  }

  private async generateVoucherNumber(queryRunner: QueryRunner, voucherType: string): Promise<string> {
    const year = new Date().getFullYear();
    const typePrefix = voucherType.substring(0, 2); // PY, RE, JO, CO
    return await this.sequenceGenerator.generateSequence(`VCH_NO_${voucherType}_${year}`, `${typePrefix}${year}`, 4);
  }

  private mapVoucherTypeToTransactionType(voucherType: string): string {
    switch (voucherType) {
      case 'PAYMENT':
        return 'PAYMENT';
      case 'RECEIPT':
        return 'RECEIPT';
      case 'JOURNAL':
      case 'CONTRA':
        return 'JOURNAL';
      default:
        return 'JOURNAL';
    }
  }

  private mapToResponseDto(transaction: Transaction): TransactionResponseDto {
    return plainToClass(TransactionResponseDto, {
      ...transaction,
      member: transaction.member ? {
        id: transaction.member.id,
        memberNumber: transaction.member.memberNumber,
        firstName: transaction.member.firstName,
        lastName: transaction.member.lastName,
        fullName: transaction.member.fullName,
      } : undefined,
    }, { excludeExtraneousValues: true });
  }

  private mapVoucherToResponseDto(voucher: Voucher): VoucherResponseDto {
    return plainToClass(VoucherResponseDto, {
      ...voucher,
      member: voucher.member ? {
        id: voucher.member.id,
        memberNumber: voucher.member.memberNumber,
        firstName: voucher.member.firstName,
        lastName: voucher.member.lastName,
        fullName: voucher.member.fullName,
      } : undefined,
      transactions: voucher.transactions?.map(txn => this.mapToResponseDto(txn)),
    }, { excludeExtraneousValues: true });
  }
}
