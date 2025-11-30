import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, Like, Between, In, SelectQueryBuilder } from 'typeorm';
import { Member } from '../../member/entities/member.entity';
import { LoanAccount } from '../../loan/entities/loan-account.entity';
import { FixedDeposit } from '../../deposit/entities/fixed-deposit.entity';
import { Transaction } from '../../transaction/entities/transaction.entity';
import { 
  SearchFiltersDto, 
  GlobalSearchDto, 
  SearchResult, 
  GlobalSearchResult,
  SearchEntityType 
} from '../dto/search.dto';

@Injectable()
export class SearchService {
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

  async globalSearch(searchDto: GlobalSearchDto): Promise<GlobalSearchResult> {
    const { query, entityType, page = 1, limit = 10 } = searchDto;

    const result: GlobalSearchResult = {
      members: { data: [], total: 0, page, limit, totalPages: 0 },
      loans: { data: [], total: 0, page, limit, totalPages: 0 },
      deposits: { data: [], total: 0, page, limit, totalPages: 0 },
      transactions: { data: [], total: 0, page, limit, totalPages: 0 },
      totalResults: 0,
    };

    if (entityType === SearchEntityType.ALL || entityType === SearchEntityType.MEMBER) {
      result.members = await this.searchMembers({ query, page, limit });
    }

    if (entityType === SearchEntityType.ALL || entityType === SearchEntityType.LOAN) {
      result.loans = await this.searchLoans({ query, page, limit });
    }

    if (entityType === SearchEntityType.ALL || entityType === SearchEntityType.DEPOSIT) {
      result.deposits = await this.searchDeposits({ query, page, limit });
    }

    if (entityType === SearchEntityType.ALL || entityType === SearchEntityType.TRANSACTION) {
      result.transactions = await this.searchTransactions({ query, page, limit });
    }

    result.totalResults = result.members.total + result.loans.total + 
                         result.deposits.total + result.transactions.total;

    return result;
  }

  async searchMembers(filters: SearchFiltersDto): Promise<SearchResult<Member>> {
    const { page = 1, limit = 10 } = filters;
    const skip = (page - 1) * limit;

    const queryBuilder = this.memberRepository.createQueryBuilder('member');

    this.applyMemberFilters(queryBuilder, filters);

    const [data, total] = await queryBuilder
      .skip(skip)
      .take(limit)
      .orderBy('member.memberNumber', 'ASC')
      .getManyAndCount();

    return {
      data,
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    };
  }

  async searchLoans(filters: SearchFiltersDto): Promise<SearchResult<LoanAccount>> {
    const { page = 1, limit = 10 } = filters;
    const skip = (page - 1) * limit;

    const queryBuilder = this.loanRepository.createQueryBuilder('loan')
      .leftJoinAndSelect('loan.member', 'member');

    this.applyLoanFilters(queryBuilder, filters);

    const [data, total] = await queryBuilder
      .skip(skip)
      .take(limit)
      .orderBy('loan.accountNumber', 'ASC')
      .getManyAndCount();

    return {
      data,
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    };
  }

  async searchDeposits(filters: SearchFiltersDto): Promise<SearchResult<FixedDeposit>> {
    const { page = 1, limit = 10 } = filters;
    const skip = (page - 1) * limit;

    const queryBuilder = this.depositRepository.createQueryBuilder('deposit')
      .leftJoinAndSelect('deposit.member', 'member');

    this.applyDepositFilters(queryBuilder, filters);

    const [data, total] = await queryBuilder
      .skip(skip)
      .take(limit)
      .orderBy('deposit.accountNumber', 'ASC')
      .getManyAndCount();

    return {
      data,
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    };
  }

  async searchTransactions(filters: SearchFiltersDto): Promise<SearchResult<Transaction>> {
    const { page = 1, limit = 10 } = filters;
    const skip = (page - 1) * limit;

    const queryBuilder = this.transactionRepository.createQueryBuilder('transaction')
      .leftJoinAndSelect('transaction.member', 'member');

    this.applyTransactionFilters(queryBuilder, filters);

    const [data, total] = await queryBuilder
      .skip(skip)
      .take(limit)
      .orderBy('transaction.transactionDate', 'DESC')
      .getManyAndCount();

    return {
      data,
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    };
  }

  private applyMemberFilters(queryBuilder: SelectQueryBuilder<Member>, filters: SearchFiltersDto): void {
    if (filters.query) {
      queryBuilder.andWhere(
        '(member.firstName ILIKE :query OR member.lastName ILIKE :query OR member.memberNumber ILIKE :query OR member.phoneNumber ILIKE :query OR member.email ILIKE :query)',
        { query: `%${filters.query}%` }
      );
    }

    if (filters.memberNumber) {
      queryBuilder.andWhere('member.memberNumber ILIKE :memberNumber', {
        memberNumber: `%${filters.memberNumber}%`,
      });
    }

    if (filters.status) {
      queryBuilder.andWhere('member.status = :status', { status: filters.status });
    }

    if (filters.dateFrom && filters.dateTo) {
      queryBuilder.andWhere('member.createdAt BETWEEN :dateFrom AND :dateTo', {
        dateFrom: filters.dateFrom,
        dateTo: filters.dateTo,
      });
    }

    if (filters.memberIds && filters.memberIds.length > 0) {
      queryBuilder.andWhere('member.id IN (:...memberIds)', { memberIds: filters.memberIds });
    }
  }

  private applyLoanFilters(queryBuilder: SelectQueryBuilder<LoanAccount>, filters: SearchFiltersDto): void {
    if (filters.query) {
      queryBuilder.andWhere(
        '(loan.accountNumber ILIKE :query OR member.firstName ILIKE :query OR member.lastName ILIKE :query OR member.memberNumber ILIKE :query)',
        { query: `%${filters.query}%` }
      );
    }

    if (filters.accountNumber) {
      queryBuilder.andWhere('loan.accountNumber ILIKE :accountNumber', {
        accountNumber: `%${filters.accountNumber}%`,
      });
    }

    if (filters.memberNumber) {
      queryBuilder.andWhere('member.memberNumber ILIKE :memberNumber', {
        memberNumber: `%${filters.memberNumber}%`,
      });
    }

    if (filters.status) {
      queryBuilder.andWhere('loan.status = :status', { status: filters.status });
    }

    if (filters.loanType) {
      queryBuilder.andWhere('loan.loanType = :loanType', { loanType: filters.loanType });
    }

    if (filters.amountFrom !== undefined) {
      queryBuilder.andWhere('loan.principalAmount >= :amountFrom', { amountFrom: filters.amountFrom });
    }

    if (filters.amountTo !== undefined) {
      queryBuilder.andWhere('loan.principalAmount <= :amountTo', { amountTo: filters.amountTo });
    }

    if (filters.dateFrom && filters.dateTo) {
      queryBuilder.andWhere('loan.disbursementDate BETWEEN :dateFrom AND :dateTo', {
        dateFrom: filters.dateFrom,
        dateTo: filters.dateTo,
      });
    }

    if (filters.memberIds && filters.memberIds.length > 0) {
      queryBuilder.andWhere('loan.memberId IN (:...memberIds)', { memberIds: filters.memberIds });
    }
  }

  private applyDepositFilters(queryBuilder: SelectQueryBuilder<FixedDeposit>, filters: SearchFiltersDto): void {
    if (filters.query) {
      queryBuilder.andWhere(
        '(deposit.accountNumber ILIKE :query OR member.firstName ILIKE :query OR member.lastName ILIKE :query OR member.memberNumber ILIKE :query)',
        { query: `%${filters.query}%` }
      );
    }

    if (filters.accountNumber) {
      queryBuilder.andWhere('deposit.accountNumber ILIKE :accountNumber', {
        accountNumber: `%${filters.accountNumber}%`,
      });
    }

    if (filters.memberNumber) {
      queryBuilder.andWhere('member.memberNumber ILIKE :memberNumber', {
        memberNumber: `%${filters.memberNumber}%`,
      });
    }

    if (filters.status) {
      queryBuilder.andWhere('deposit.status = :status', { status: filters.status });
    }

    if (filters.amountFrom !== undefined) {
      queryBuilder.andWhere('deposit.principalAmount >= :amountFrom', { amountFrom: filters.amountFrom });
    }

    if (filters.amountTo !== undefined) {
      queryBuilder.andWhere('deposit.principalAmount <= :amountTo', { amountTo: filters.amountTo });
    }

    if (filters.dateFrom && filters.dateTo) {
      queryBuilder.andWhere('deposit.depositDate BETWEEN :dateFrom AND :dateTo', {
        dateFrom: filters.dateFrom,
        dateTo: filters.dateTo,
      });
    }

    if (filters.memberIds && filters.memberIds.length > 0) {
      queryBuilder.andWhere('deposit.memberId IN (:...memberIds)', { memberIds: filters.memberIds });
    }
  }

  private applyTransactionFilters(queryBuilder: SelectQueryBuilder<Transaction>, filters: SearchFiltersDto): void {
    if (filters.query) {
      queryBuilder.andWhere(
        '(transaction.transactionNumber ILIKE :query OR transaction.description ILIKE :query OR transaction.voucherNumber ILIKE :query OR member.firstName ILIKE :query OR member.lastName ILIKE :query)',
        { query: `%${filters.query}%` }
      );
    }

    if (filters.memberNumber) {
      queryBuilder.andWhere('member.memberNumber ILIKE :memberNumber', {
        memberNumber: `%${filters.memberNumber}%`,
      });
    }

    if (filters.status) {
      queryBuilder.andWhere('transaction.status = :status', { status: filters.status });
    }

    if (filters.amountFrom !== undefined) {
      queryBuilder.andWhere('transaction.amount >= :amountFrom', { amountFrom: filters.amountFrom });
    }

    if (filters.amountTo !== undefined) {
      queryBuilder.andWhere('transaction.amount <= :amountTo', { amountTo: filters.amountTo });
    }

    if (filters.dateFrom && filters.dateTo) {
      queryBuilder.andWhere('transaction.transactionDate BETWEEN :dateFrom AND :dateTo', {
        dateFrom: filters.dateFrom,
        dateTo: filters.dateTo,
      });
    }

    if (filters.memberIds && filters.memberIds.length > 0) {
      queryBuilder.andWhere('transaction.memberId IN (:...memberIds)', { memberIds: filters.memberIds });
    }
  }}
