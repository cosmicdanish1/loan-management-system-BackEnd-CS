import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository, SelectQueryBuilder } from 'typeorm';
import { Transaction } from '../../transaction/entities/transaction.entity';
import {
  SearchFiltersDto,
  GlobalSearchDto,
  SearchResult,
  GlobalSearchResult,
  SearchEntityType
} from '../dto/search.dto';

// BUG FIX: searchMembers/searchLoans/searchDeposits used to query the
// Member/LoanAccount/FixedDeposit TypeORM entities (tables `members`,
// `loan_accounts`, `fixed_deposits`) — all three are disconnected demo
// tables with 0 rows in production (confirmed live). Real data lives in
// `member_master` / `loan_master` / `fdmaster`, which have no TypeORM
// entities wired into this module's relations, so those three methods now
// query them directly via raw SQL (same pattern as MemberLookupService).
@Injectable()
export class SearchService {
  constructor(
    private dataSource: DataSource,
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

    if (entityType === SearchEntityType.ALL || entityType === SearchEntityType.LOAN || entityType === SearchEntityType.ACCOUNT) {
      result.loans = await this.searchLoans({ query, page, limit });
    }

    if (entityType === SearchEntityType.ALL || entityType === SearchEntityType.DEPOSIT || entityType === SearchEntityType.ACCOUNT) {
      result.deposits = await this.searchDeposits({ query, page, limit });
    }

    if (entityType === SearchEntityType.ALL || entityType === SearchEntityType.TRANSACTION) {
      result.transactions = await this.searchTransactions({ query, page, limit });
    }

    result.totalResults = result.members.total + result.loans.total + 
                         result.deposits.total + result.transactions.total;

    return result;
  }

  async searchMembers(filters: SearchFiltersDto): Promise<SearchResult<any>> {
    const { page = 1, limit = 10, query, memberNumber } = filters;
    const skip = (page - 1) * limit;

    const conditions: string[] = [];
    const params: any[] = [];

    if (query) {
      params.push(`%${query}%`);
      conditions.push(`(m.mbno::text ILIKE $${params.length} OR TRIM(COALESCE(m.f_name,'') || ' ' || COALESCE(m.m_name,'') || ' ' || COALESCE(m.l_name,'')) ILIKE $${params.length})`);
    }
    if (memberNumber) {
      params.push(`%${memberNumber}%`);
      conditions.push(`m.mbno::text ILIKE $${params.length}`);
    }
    const whereClause = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const fromClause = `
      FROM member_master m
      LEFT JOIN wingmast w ON m.wingno = w.wingno
      LEFT JOIN division_master d ON m.officeno = d.officeno AND m.wingno = d.wingno
      ${whereClause}
    `;

    const countResult = await this.dataSource.query(`SELECT COUNT(*)::int as count ${fromClause}`, params);
    const total = countResult[0]?.count || 0;

    const dataParams = [...params, limit, skip];
    const data = await this.dataSource.query(
      `SELECT
        m.mbno as "mbno",
        TRIM(COALESCE(m.f_name,'') || ' ' || COALESCE(m.m_name,'') || ' ' || COALESCE(m.l_name,'')) as "name",
        m.wingno as "wingNo",
        COALESCE(w.wname, '') as "wingName",
        m.officeno as "officeNo",
        COALESCE(d.name, '') as "divisionName"
      ${fromClause}
      ORDER BY m.mbno
      LIMIT $${dataParams.length - 1} OFFSET $${dataParams.length}`,
      dataParams,
    );

    return { data, total, page, limit, totalPages: Math.ceil(total / limit) };
  }

  async searchLoans(filters: SearchFiltersDto): Promise<SearchResult<any>> {
    const { page = 1, limit = 10, query, accountNumber, memberNumber } = filters;
    const skip = (page - 1) * limit;

    const conditions: string[] = [];
    const params: any[] = [];
    const nameExpr = `TRIM(COALESCE(m.f_name,'') || ' ' || COALESCE(m.m_name,'') || ' ' || COALESCE(m.l_name,''))`;

    if (query) {
      params.push(`%${query}%`);
      conditions.push(`(l.loancaseno::text ILIKE $${params.length} OR l.mbno::text ILIKE $${params.length} OR ${nameExpr} ILIKE $${params.length})`);
    }
    if (accountNumber) {
      params.push(`%${accountNumber}%`);
      conditions.push(`l.loancaseno::text ILIKE $${params.length}`);
    }
    if (memberNumber) {
      params.push(`%${memberNumber}%`);
      conditions.push(`l.mbno::text ILIKE $${params.length}`);
    }
    const whereClause = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const fromClause = `
      FROM loan_master l
      LEFT JOIN member_master m ON l.mbno = m.mbno
      LEFT JOIN wingmast w ON m.wingno = w.wingno
      LEFT JOIN division_master d ON m.officeno = d.officeno AND m.wingno = d.wingno
      ${whereClause}
    `;

    const countResult = await this.dataSource.query(`SELECT COUNT(*)::int as count ${fromClause}`, params);
    const total = countResult[0]?.count || 0;

    const dataParams = [...params, limit, skip];
    const data = await this.dataSource.query(
      `SELECT
        l.loancaseno as "loanCaseNo",
        l.loantype as "loanType",
        l.mbno as "mbno",
        ${nameExpr} as "name",
        l.balance as "balance",
        m.wingno as "wingNo",
        COALESCE(w.wname, '') as "wingName",
        m.officeno as "officeNo",
        COALESCE(d.name, '') as "divisionName"
      ${fromClause}
      ORDER BY l.loancaseno
      LIMIT $${dataParams.length - 1} OFFSET $${dataParams.length}`,
      dataParams,
    );

    return { data, total, page, limit, totalPages: Math.ceil(total / limit) };
  }

  async searchDeposits(filters: SearchFiltersDto): Promise<SearchResult<any>> {
    const { page = 1, limit = 10, query, accountNumber, memberNumber } = filters;
    const skip = (page - 1) * limit;

    const conditions: string[] = [];
    const params: any[] = [];
    const nameExpr = `TRIM(COALESCE(f.f_name,'') || ' ' || COALESCE(f.m_name,'') || ' ' || COALESCE(f.l_name,''))`;

    if (query) {
      params.push(`%${query}%`);
      conditions.push(`(f.account_number::text ILIKE $${params.length} OR f.mbno::text ILIKE $${params.length} OR ${nameExpr} ILIKE $${params.length})`);
    }
    if (accountNumber) {
      params.push(`%${accountNumber}%`);
      conditions.push(`f.account_number::text ILIKE $${params.length}`);
    }
    if (memberNumber) {
      params.push(`%${memberNumber}%`);
      conditions.push(`f.mbno::text ILIKE $${params.length}`);
    }
    const whereClause = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const fromClause = `
      FROM fdmaster f
      LEFT JOIN member_master m ON f.mbno = m.mbno
      LEFT JOIN wingmast w ON m.wingno = w.wingno
      LEFT JOIN division_master d ON m.officeno = d.officeno AND m.wingno = d.wingno
      ${whereClause}
    `;

    const countResult = await this.dataSource.query(`SELECT COUNT(*)::int as count ${fromClause}`, params);
    const total = countResult[0]?.count || 0;

    const dataParams = [...params, limit, skip];
    const data = await this.dataSource.query(
      `SELECT
        f.account_number as "accountNumber",
        f.mbno as "mbno",
        ${nameExpr} as "name",
        f.fdrdflag as "fdrdflag",
        m.wingno as "wingNo",
        COALESCE(w.wname, '') as "wingName",
        m.officeno as "officeNo",
        COALESCE(d.name, '') as "divisionName"
      ${fromClause}
      ORDER BY f.account_number
      LIMIT $${dataParams.length - 1} OFFSET $${dataParams.length}`,
      dataParams,
    );

    return { data, total, page, limit, totalPages: Math.ceil(total / limit) };
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
