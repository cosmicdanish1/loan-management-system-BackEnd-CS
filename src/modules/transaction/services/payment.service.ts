import {
  Injectable,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, DataSource, QueryRunner } from 'typeorm';
import { Transaction, Voucher } from '../entities';
import { Member } from '../../member/entities/member.entity';
import { LoanAccount } from '../../loan/entities/loan-account.entity';
import { FixedDeposit } from '../../deposit/entities/fixed-deposit.entity';

export interface PaymentVoucherDto {
  memberId?: number;
  payeeName: string;
  amount: number;
  description: string;
  paymentMethod: 'CASH' | 'CHEQUE' | 'BANK_TRANSFER';
  chequeNumber?: string;
  chequeDate?: string;
  bankName?: string;
  accountCode: string; // The account being debited (usually CASH or BANK)
  expenseAccount: string; // The expense account being credited
  referenceType?: string;
  referenceId?: number;
  remarks?: string;
}

export interface ReceiptVoucherDto {
  memberId: number;
  amount: number;
  description: string;
  receiptMethod: 'CASH' | 'CHEQUE' | 'BANK_TRANSFER';
  chequeNumber?: string;
  chequeDate?: string;
  bankName?: string;
  accountCode: string; // The account being credited (usually CASH or BANK)
  incomeAccount: string; // The income account being debited
  referenceType?: string;
  referenceId?: number;
  remarks?: string;
}

export interface MemberBalanceTransferDto {
  fromMemberId: number;
  toMemberId: number;
  amount: number;
  description: string;
  transferType: 'SHARE_TRANSFER' | 'DEPOSIT_TRANSFER' | 'LOAN_ADJUSTMENT';
  remarks?: string;
}

@Injectable()
export class PaymentService {
  constructor(
    @InjectRepository(Transaction)
    private transactionRepository: Repository<Transaction>,
    @InjectRepository(Voucher)
    private voucherRepository: Repository<Voucher>,
    @InjectRepository(Member)
    private memberRepository: Repository<Member>,
    private dataSource: DataSource,
  ) {}

  async createPaymentVoucher(paymentDto: PaymentVoucherDto): Promise<any> {
    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();

    try {
      // Validate member if provided
      let member = null;
      if (paymentDto.memberId) {
        member = await queryRunner.manager.findOne(Member, {
          where: { id: paymentDto.memberId },
        });
        if (!member) {
          throw new NotFoundException(`Member with ID ${paymentDto.memberId} not found`);
        }
      }

      // Generate voucher number
      const voucherNumber = await this.generateVoucherNumber(queryRunner, 'PAYMENT');

      // Create payment voucher
      const voucher = queryRunner.manager.create(Voucher, {
        voucherNumber,
        voucherDate: new Date(),
        voucherType: 'PAYMENT',
        totalAmount: paymentDto.amount,
        description: paymentDto.description,
        memberId: paymentDto.memberId,
        payeeName: paymentDto.payeeName,
        chequeNumber: paymentDto.chequeNumber,
        chequeDate: paymentDto.chequeDate ? new Date(paymentDto.chequeDate) : null,
        bankName: paymentDto.bankName,
        status: 'ACTIVE',
        remarks: paymentDto.remarks,
      });

      const savedVoucher = await queryRunner.manager.save(voucher);

      // Create transaction (Debit Account, Credit Expense)
      const transactionNumber = await this.generateTransactionNumber(queryRunner);
      
      const transaction = queryRunner.manager.create(Transaction, {
        transactionNumber,
        transactionDate: new Date(),
        transactionType: 'PAYMENT',
        amount: paymentDto.amount,
        description: paymentDto.description,
        debitAccount: paymentDto.expenseAccount, // Expense account debited
        creditAccount: paymentDto.accountCode, // Cash/Bank account credited
        memberId: paymentDto.memberId,
        voucherNumber: savedVoucher.voucherNumber,
        referenceType: paymentDto.referenceType,
        referenceId: paymentDto.referenceId,
        status: 'POSTED',
        remarks: paymentDto.remarks,
      });

      await queryRunner.manager.save(transaction);
      await queryRunner.commitTransaction();

      return {
        voucher: savedVoucher,
        transaction,
        receiptNumber: voucherNumber,
      };
    } catch (error) {
      await queryRunner.rollbackTransaction();
      throw error;
    } finally {
      await queryRunner.release();
    }
  }

  async createReceiptVoucher(receiptDto: ReceiptVoucherDto): Promise<any> {
    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();

    try {
      // Validate member
      const member = await queryRunner.manager.findOne(Member, {
        where: { id: receiptDto.memberId },
      });
      if (!member) {
        throw new NotFoundException(`Member with ID ${receiptDto.memberId} not found`);
      }

      // Generate voucher number
      const voucherNumber = await this.generateVoucherNumber(queryRunner, 'RECEIPT');

      // Create receipt voucher
      const voucher = queryRunner.manager.create(Voucher, {
        voucherNumber,
        voucherDate: new Date(),
        voucherType: 'RECEIPT',
        totalAmount: receiptDto.amount,
        description: receiptDto.description,
        memberId: receiptDto.memberId,
        payeeName: member.fullName,
        chequeNumber: receiptDto.chequeNumber,
        chequeDate: receiptDto.chequeDate ? new Date(receiptDto.chequeDate) : null,
        bankName: receiptDto.bankName,
        status: 'ACTIVE',
        remarks: receiptDto.remarks,
      });

      const savedVoucher = await queryRunner.manager.save(voucher);

      // Create transaction (Debit Cash/Bank, Credit Income)
      const transactionNumber = await this.generateTransactionNumber(queryRunner);
      
      const transaction = queryRunner.manager.create(Transaction, {
        transactionNumber,
        transactionDate: new Date(),
        transactionType: 'RECEIPT',
        amount: receiptDto.amount,
        description: receiptDto.description,
        debitAccount: receiptDto.accountCode, // Cash/Bank account debited
        creditAccount: receiptDto.incomeAccount, // Income account credited
        memberId: receiptDto.memberId,
        voucherNumber: savedVoucher.voucherNumber,
        referenceType: receiptDto.referenceType,
        referenceId: receiptDto.referenceId,
        status: 'POSTED',
        remarks: receiptDto.remarks,
      });

      await queryRunner.manager.save(transaction);
      await queryRunner.commitTransaction();

      return {
        voucher: savedVoucher,
        transaction,
        receiptNumber: voucherNumber,
      };
    } catch (error) {
      await queryRunner.rollbackTransaction();
      throw error;
    } finally {
      await queryRunner.release();
    }
  }

  async createMemberBalanceTransfer(transferDto: MemberBalanceTransferDto): Promise<any> {
    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();

    try {
      // Validate both members
      const fromMember = await queryRunner.manager.findOne(Member, {
        where: { id: transferDto.fromMemberId },
      });
      if (!fromMember) {
        throw new NotFoundException(`From member with ID ${transferDto.fromMemberId} not found`);
      }

      const toMember = await queryRunner.manager.findOne(Member, {
        where: { id: transferDto.toMemberId },
      });
      if (!toMember) {
        throw new NotFoundException(`To member with ID ${transferDto.toMemberId} not found`);
      }

      // Generate voucher number
      const voucherNumber = await this.generateVoucherNumber(queryRunner, 'JOURNAL');

      // Create transfer voucher
      const voucher = queryRunner.manager.create(Voucher, {
        voucherNumber,
        voucherDate: new Date(),
        voucherType: 'JOURNAL',
        totalAmount: transferDto.amount,
        description: `Balance transfer from ${fromMember.fullName} to ${toMember.fullName}`,
        status: 'ACTIVE',
        remarks: transferDto.remarks,
      });

      const savedVoucher = await queryRunner.manager.save(voucher);

      // Create debit transaction (from member)
      const debitTransactionNumber = await this.generateTransactionNumber(queryRunner);
      const debitTransaction = queryRunner.manager.create(Transaction, {
        transactionNumber: debitTransactionNumber,
        transactionDate: new Date(),
        transactionType: 'TRANSFER',
        amount: transferDto.amount,
        description: `Transfer to ${toMember.fullName} - ${transferDto.description}`,
        debitAccount: this.getAccountCodeForTransferType(transferDto.transferType, fromMember.id),
        creditAccount: 'MEMBER_TRANSFER_SUSPENSE',
        memberId: transferDto.fromMemberId,
        voucherNumber: savedVoucher.voucherNumber,
        referenceType: 'BALANCE_TRANSFER',
        status: 'POSTED',
        remarks: transferDto.remarks,
      });

      // Create credit transaction (to member)
      const creditTransactionNumber = await this.generateTransactionNumber(queryRunner);
      const creditTransaction = queryRunner.manager.create(Transaction, {
        transactionNumber: creditTransactionNumber,
        transactionDate: new Date(),
        transactionType: 'TRANSFER',
        amount: transferDto.amount,
        description: `Transfer from ${fromMember.fullName} - ${transferDto.description}`,
        debitAccount: 'MEMBER_TRANSFER_SUSPENSE',
        creditAccount: this.getAccountCodeForTransferType(transferDto.transferType, toMember.id),
        memberId: transferDto.toMemberId,
        voucherNumber: savedVoucher.voucherNumber,
        referenceType: 'BALANCE_TRANSFER',
        status: 'POSTED',
        remarks: transferDto.remarks,
      });

      await queryRunner.manager.save([debitTransaction, creditTransaction]);

      // Update member balances based on transfer type
      await this.updateMemberBalances(queryRunner, transferDto);

      await queryRunner.commitTransaction();

      return {
        voucher: savedVoucher,
        debitTransaction,
        creditTransaction,
        transferNumber: voucherNumber,
      };
    } catch (error) {
      await queryRunner.rollbackTransaction();
      throw error;
    } finally {
      await queryRunner.release();
    }
  }

  async rollbackTransaction(transactionId: number, reason: string): Promise<any> {
    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();

    try {
      const transaction = await queryRunner.manager.findOne(Transaction, {
        where: { id: transactionId },
        relations: ['member'],
      });

      if (!transaction) {
        throw new NotFoundException(`Transaction with ID ${transactionId} not found`);
      }

      if (transaction.status !== 'POSTED') {
        throw new BadRequestException('Only posted transactions can be rolled back');
      }

      // Create rollback transaction
      const rollbackTransactionNumber = await this.generateTransactionNumber(queryRunner);
      
      const rollbackTransaction = queryRunner.manager.create(Transaction, {
        transactionNumber: rollbackTransactionNumber,
        transactionDate: new Date(),
        transactionType: transaction.transactionType,
        amount: transaction.amount,
        description: `ROLLBACK: ${transaction.description} - ${reason}`,
        debitAccount: transaction.creditAccount, // Reverse the accounts
        creditAccount: transaction.debitAccount,
        memberId: transaction.memberId,
        voucherNumber: transaction.voucherNumber,
        referenceType: 'ROLLBACK',
        referenceId: transaction.id,
        status: 'POSTED',
        remarks: `Rollback of transaction ${transaction.transactionNumber}: ${reason}`,
      });

      await queryRunner.manager.save(rollbackTransaction);

      // Update original transaction status
      transaction.status = 'REVERSED';
      transaction.reversedTransactionId = rollbackTransaction.id;
      transaction.reversedAt = new Date();
      await queryRunner.manager.save(transaction);

      await queryRunner.commitTransaction();

      return {
        originalTransaction: transaction,
        rollbackTransaction,
      };
    } catch (error) {
      await queryRunner.rollbackTransaction();
      throw error;
    } finally {
      await queryRunner.release();
    }
  }

  private async generateVoucherNumber(queryRunner: QueryRunner, voucherType: string): Promise<string> {
    const year = new Date().getFullYear();
    let typePrefix: string;
    
    // Map voucher types to prefixes
    switch (voucherType) {
      case 'PAYMENT':
        typePrefix = 'PY';
        break;
      case 'RECEIPT':
        typePrefix = 'RE';
        break;
      case 'JOURNAL':
        typePrefix = 'JO';
        break;
      case 'CONTRA':
        typePrefix = 'CO';
        break;
      default:
        typePrefix = voucherType.substring(0, 2).toUpperCase();
    }
    
    const prefix = `${typePrefix}${year}`;
    
    const lastVoucher = await queryRunner.manager
      .createQueryBuilder(Voucher, 'voucher')
      .where('voucher.voucherNumber LIKE :prefix', { prefix: `${prefix}%` })
      .orderBy('voucher.voucherNumber', 'DESC')
      .getOne();

    let nextNumber = 1;
    if (lastVoucher) {
      const lastNumber = parseInt(lastVoucher.voucherNumber.substring(prefix.length));
      nextNumber = lastNumber + 1;
    }

    return `${prefix}${nextNumber.toString().padStart(4, '0')}`;
  }

  private async generateTransactionNumber(queryRunner: QueryRunner): Promise<string> {
    const year = new Date().getFullYear();
    const prefix = `TXN${year}`;
    
    const lastTransaction = await queryRunner.manager
      .createQueryBuilder(Transaction, 'transaction')
      .where('transaction.transactionNumber LIKE :prefix', { prefix: `${prefix}%` })
      .orderBy('transaction.transactionNumber', 'DESC')
      .getOne();

    let nextNumber = 1;
    if (lastTransaction) {
      const lastNumber = parseInt(lastTransaction.transactionNumber.substring(prefix.length));
      nextNumber = lastNumber + 1;
    }

    return `${prefix}${nextNumber.toString().padStart(6, '0')}`;
  }

  private getAccountCodeForTransferType(transferType: string, memberId: number): string {
    switch (transferType) {
      case 'SHARE_TRANSFER':
        return `MEMBER_SHARE_${memberId}`;
      case 'DEPOSIT_TRANSFER':
        return `MEMBER_DEPOSIT_${memberId}`;
      case 'LOAN_ADJUSTMENT':
        return `MEMBER_LOAN_${memberId}`;
      default:
        return `MEMBER_GENERAL_${memberId}`;
    }
  }

  private async updateMemberBalances(queryRunner: QueryRunner, transferDto: MemberBalanceTransferDto): Promise<void> {
    // This would update the actual member balances based on the transfer type
    // For now, we'll just log the transfer - in a real implementation,
    // this would update the relevant balance fields in member or related entities
    
    if (transferDto.transferType === 'SHARE_TRANSFER') {
      // Update share amounts
      await queryRunner.manager.decrement(
        Member,
        { id: transferDto.fromMemberId },
        'shareAmount',
        transferDto.amount,
      );
      
      await queryRunner.manager.increment(
        Member,
        { id: transferDto.toMemberId },
        'shareAmount',
        transferDto.amount,
      );
    }
    
    // Additional balance updates would be implemented here for other transfer types
  }
}
