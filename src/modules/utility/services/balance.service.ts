import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Member } from '../../member/entities/member.entity';
import { LoanAccount } from '../../loan/entities/loan-account.entity';
import { FixedDeposit } from '../../deposit/entities/fixed-deposit.entity';
import { Transaction } from '../../transaction/entities/transaction.entity';
import { 
  MemberBalanceInquiryDto, 
  AccountStatementDto, 
  MemberBalance, 
  AccountBalance, 
  AccountStatement,
  AccountStatementTransaction 
} from '../dto/balance.dto';

@Injectable()
export class BalanceService {
  constructor(
    @InjectRepository(Member)
    private memberRepository: Repository<Member>,
    @InjectRepository(LoanAccount)
    private loanRepository: Repository<LoanAccount>,
    @InjectRepository(FixedDeposit)
    private depositRepository: Repository<FixedDeposit>,
    @InjectRepository(Transaction)
    private transactionRepository: Repository<Transaction>,
  ) {}

  async getMemberBalance(inquiryDto: MemberBalanceInquiryDto): Promise<MemberBalance> {
    const { memberId, asOfDate } = inquiryDto;
    const cutoffDate = asOfDate ? new Date(asOfDate) : new Date();

    // Get member details
    const member = await this.memberRepository.findOne({
      where: { id: memberId },
    });

    if (!member) {
      throw new Error('Member not found');
    }

    // Calculate share balance
    const shareBalance = Number(member.shareAmount) || 0;

    // Calculate total loan balance
    const loanBalances = await this.loanRepository
      .createQueryBuilder('loan')
      .select('SUM(loan.outstandingBalance)', 'totalBalance')
      .where('loan.memberId = :memberId', { memberId })
      .andWhere('loan.status = :status', { status: 'ACTIVE' })
      .andWhere('loan.disbursementDate <= :cutoffDate', { cutoffDate })
      .getRawOne();

    const totalLoanBalance = Number(loanBalances?.totalBalance) || 0;

    // Calculate total deposit balance
    const depositBalances = await this.depositRepository
      .createQueryBuilder('deposit')
      .select('SUM(deposit.principalAmount + deposit.interestAccrued)', 'totalBalance')
      .where('deposit.memberId = :memberId', { memberId })
      .andWhere('deposit.status = :status', { status: 'ACTIVE' })
      .andWhere('deposit.depositDate <= :cutoffDate', { cutoffDate })
      .getRawOne();

    const totalDepositBalance = Number(depositBalances?.totalBalance) || 0;

    // Get last transaction date
    const lastTransaction = await this.transactionRepository
      .createQueryBuilder('transaction')
      .where('transaction.memberId = :memberId', { memberId })
      .andWhere('transaction.transactionDate <= :cutoffDate', { cutoffDate })
      .orderBy('transaction.transactionDate', 'DESC')
      .getOne();

    // Calculate net balance (deposits + shares - loans)
    const netBalance = shareBalance + totalDepositBalance - totalLoanBalance;

    return {
      memberId: member.id,
      memberNumber: member.memberNumber,
      memberName: member.fullName,
      shareBalance,
      totalLoanBalance,
      totalDepositBalance,
      netBalance,
      lastTransactionDate: lastTransaction?.transactionDate || null,
      asOfDate: cutoffDate,
    };
  }

  async getAccountBalance(accountType: string, accountId: number): Promise<AccountBalance> {
    let account: any;
    let currentBalance = 0;
    let availableBalance = 0;

    switch (accountType.toLowerCase()) {
      case 'loan':
        account = await this.loanRepository.findOne({
          where: { id: accountId },
          relations: ['member'],
        });
        if (account) {
          currentBalance = Number(account.outstandingBalance);
          availableBalance = currentBalance; // For loans, available = outstanding
        }
        break;

      case 'deposit':
        account = await this.depositRepository.findOne({
          where: { id: accountId },
          relations: ['member'],
        });
        if (account) {
          currentBalance = account.currentValue;
          availableBalance = account.status === 'ACTIVE' ? currentBalance : 0;
        }
        break;

      default:
        throw new Error('Invalid account type');
    }

    if (!account) {
      throw new Error('Account not found');
    }

    // Get last transaction date for this account
    const lastTransaction = await this.transactionRepository
      .createQueryBuilder('transaction')
      .where('transaction.referenceType = :refType', { 
        refType: accountType.toUpperCase() + '_TRANSACTION' 
      })
      .andWhere('transaction.referenceId = :accountId', { accountId })
      .orderBy('transaction.transactionDate', 'DESC')
      .getOne();

    return {
      accountId: account.id,
      accountNumber: account.accountNumber,
      accountType: accountType.toLowerCase(),
      currentBalance,
      availableBalance,
      lastTransactionDate: lastTransaction?.transactionDate || account.createdAt,
      status: account.status,
    };
  }

  async generateAccountStatement(statementDto: AccountStatementDto): Promise<AccountStatement> {
    const { memberId, accountType, accountId, fromDate, toDate, includeClosed } = statementDto;

    // Get member details
    const member = await this.memberRepository.findOne({
      where: { id: memberId },
    });

    if (!member) {
      throw new Error('Member not found');
    }

    let account: any;
    let openingBalance = 0;
    let closingBalance = 0;

    // Get account details based on type
    if (accountType && accountId) {
      switch (accountType.toLowerCase()) {
        case 'loan':
          account = await this.loanRepository.findOne({
            where: { id: accountId, memberId },
          });
          break;
        case 'deposit':
          account = await this.depositRepository.findOne({
            where: { id: accountId, memberId },
          });
          break;
        default:
          throw new Error('Invalid account type');
      }

      if (!account) {
        throw new Error('Account not found');
      }
    }

    // Build transaction query
    const transactionQuery = this.transactionRepository
      .createQueryBuilder('transaction')
      .where('transaction.memberId = :memberId', { memberId })
      .andWhere('transaction.transactionDate BETWEEN :fromDate AND :toDate', {
        fromDate: new Date(fromDate),
        toDate: new Date(toDate),
      });

    // Filter by account if specified
    if (accountType && accountId) {
      transactionQuery.andWhere('transaction.referenceType = :refType', {
        refType: accountType.toUpperCase() + '_TRANSACTION',
      });
      transactionQuery.andWhere('transaction.referenceId = :accountId', { accountId });
    }

    // Include/exclude closed accounts
    if (!includeClosed) {
      transactionQuery.andWhere('transaction.status != :status', { status: 'CANCELLED' });
    }

    const transactions = await transactionQuery
      .orderBy('transaction.transactionDate', 'ASC')
      .addOrderBy('transaction.createdAt', 'ASC')
      .getMany();

    // Calculate opening balance (transactions before fromDate)
    const openingBalanceQuery = this.transactionRepository
      .createQueryBuilder('transaction')
      .select('SUM(CASE WHEN transaction.creditAccount LIKE :memberPattern THEN transaction.amount ELSE -transaction.amount END)', 'balance')
      .where('transaction.memberId = :memberId', { memberId })
      .andWhere('transaction.transactionDate < :fromDate', { fromDate: new Date(fromDate) })
      .setParameter('memberPattern', `%${member.memberNumber}%`);

    if (accountType && accountId) {
      openingBalanceQuery.andWhere('transaction.referenceType = :refType', {
        refType: accountType.toUpperCase() + '_TRANSACTION',
      });
      openingBalanceQuery.andWhere('transaction.referenceId = :accountId', { accountId });
    }

    const openingBalanceResult = await openingBalanceQuery.getRawOne();
    openingBalance = Number(openingBalanceResult?.balance) || 0;

    // Process transactions and calculate running balance
    let runningBalance = openingBalance;
    const statementTransactions: AccountStatementTransaction[] = [];
    let totalDebits = 0;
    let totalCredits = 0;

    for (const transaction of transactions) {
      const isCredit = transaction.creditAccount.includes(member.memberNumber);
      const debitAmount = isCredit ? 0 : Number(transaction.amount);
      const creditAmount = isCredit ? Number(transaction.amount) : 0;

      runningBalance += creditAmount - debitAmount;
      totalDebits += debitAmount;
      totalCredits += creditAmount;

      statementTransactions.push({
        date: transaction.transactionDate,
        transactionNumber: transaction.transactionNumber,
        description: transaction.description,
        debitAmount,
        creditAmount,
        balance: runningBalance,
        voucherNumber: transaction.voucherNumber,
        remarks: transaction.remarks,
      });
    }

    closingBalance = runningBalance;

    return {
      member: {
        id: member.id,
        memberNumber: member.memberNumber,
        name: member.fullName,
      },
      account: {
        id: account?.id || 0,
        accountNumber: account?.accountNumber || 'ALL_ACCOUNTS',
        accountType: accountType || 'all',
        openingBalance,
        closingBalance,
      },
      period: {
        fromDate: new Date(fromDate),
        toDate: new Date(toDate),
      },
      transactions: statementTransactions,
      summary: {
        totalDebits,
        totalCredits,
        transactionCount: statementTransactions.length,
      },
    };
  }

  async getMemberAccountBalances(memberId: number): Promise<{
    shareBalance: number;
    loanAccounts: AccountBalance[];
    depositAccounts: AccountBalance[];
    totalLoanBalance: number;
    totalDepositBalance: number;
    netWorth: number;
  }> {
    // Get member details
    const member = await this.memberRepository.findOne({
      where: { id: memberId },
    });

    if (!member) {
      throw new Error('Member not found');
    }

    const shareBalance = Number(member.shareAmount) || 0;

    // Get all loan accounts
    const loanAccounts = await this.loanRepository.find({
      where: { memberId, status: 'ACTIVE' },
    });

    const loanBalances: AccountBalance[] = [];
    let totalLoanBalance = 0;

    for (const loan of loanAccounts) {
      const balance: AccountBalance = {
        accountId: loan.id,
        accountNumber: loan.accountNumber,
        accountType: 'loan',
        currentBalance: Number(loan.outstandingBalance),
        availableBalance: Number(loan.outstandingBalance),
        lastTransactionDate: loan.updatedAt,
        status: loan.status,
      };
      loanBalances.push(balance);
      totalLoanBalance += balance.currentBalance;
    }

    // Get all deposit accounts
    const depositAccounts = await this.depositRepository.find({
      where: { memberId, status: 'ACTIVE' },
    });

    const depositBalances: AccountBalance[] = [];
    let totalDepositBalance = 0;

    for (const deposit of depositAccounts) {
      const balance: AccountBalance = {
        accountId: deposit.id,
        accountNumber: deposit.accountNumber,
        accountType: 'deposit',
        currentBalance: deposit.currentValue,
        availableBalance: deposit.currentValue,
        lastTransactionDate: deposit.updatedAt,
        status: deposit.status,
      };
      depositBalances.push(balance);
      totalDepositBalance += balance.currentBalance;
    }

    const netWorth = shareBalance + totalDepositBalance - totalLoanBalance;

    return {
      shareBalance,
      loanAccounts: loanBalances,
      depositAccounts: depositBalances,
      totalLoanBalance,
      totalDepositBalance,
      netWorth,
    };
  }

  async getRealtimeBalance(memberId: number): Promise<MemberBalance> {
    return this.getMemberBalance({ memberId });
  }
}
