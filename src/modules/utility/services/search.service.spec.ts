import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { SearchService } from './search.service';
import { Transaction } from '../../transaction/entities/transaction.entity';
import { SearchEntityType } from '../dto/search.dto';

describe('SearchService', () => {
  let service: SearchService;
  let dataSource: DataSource;
  let transactionRepository: Repository<Transaction>;

  const mockQueryBuilder = {
    andWhere: jest.fn().mockReturnThis(),
    skip: jest.fn().mockReturnThis(),
    take: jest.fn().mockReturnThis(),
    orderBy: jest.fn().mockReturnThis(),
    addOrderBy: jest.fn().mockReturnThis(),
    leftJoinAndSelect: jest.fn().mockReturnThis(),
    getManyAndCount: jest.fn().mockResolvedValue([[], 0]),
    getMany: jest.fn().mockResolvedValue([]),
  };

  const mockTransactionRepository = {
    createQueryBuilder: jest.fn().mockReturnValue(mockQueryBuilder),
    find: jest.fn(),
    findOne: jest.fn(),
  };

  // searchMembers/searchLoans/searchDeposits each issue a COUNT query followed
  // by a data query (see search.service.ts) — alternate the mock's resolved
  // value so both calls get sensible responses regardless of call order.
  const mockDataSource = {
    query: jest.fn().mockResolvedValue([]),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SearchService,
        {
          provide: DataSource,
          useValue: mockDataSource,
        },
        {
          provide: getRepositoryToken(Transaction),
          useValue: mockTransactionRepository,
        },
      ],
    }).compile();

    service = module.get<SearchService>(SearchService);
    dataSource = module.get<DataSource>(DataSource);
    transactionRepository = module.get<Repository<Transaction>>(getRepositoryToken(Transaction));
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('globalSearch', () => {
    it('should perform global search across all entities', async () => {
      mockDataSource.query.mockImplementation((sql: string) =>
        sql.includes('COUNT(*)') ? Promise.resolve([{ count: 0 }]) : Promise.resolve([]),
      );

      const searchDto = {
        query: 'test',
        entityType: SearchEntityType.ALL,
        page: 1,
        limit: 10,
      };

      const result = await service.globalSearch(searchDto);

      expect(result).toHaveProperty('members');
      expect(result).toHaveProperty('loans');
      expect(result).toHaveProperty('deposits');
      expect(result).toHaveProperty('transactions');
      expect(result).toHaveProperty('totalResults');
      expect(dataSource.query).toHaveBeenCalled();
      expect(transactionRepository.createQueryBuilder).toHaveBeenCalled();
    });

    it('should search only members when entityType is MEMBER', async () => {
      mockDataSource.query.mockImplementation((sql: string) =>
        sql.includes('COUNT(*)') ? Promise.resolve([{ count: 0 }]) : Promise.resolve([]),
      );

      const searchDto = {
        query: 'test',
        entityType: SearchEntityType.MEMBER,
        page: 1,
        limit: 10,
      };

      const result = await service.globalSearch(searchDto);

      expect(result.members.data).toBeDefined();
      expect(result.loans.total).toBe(0);
      expect(result.deposits.total).toBe(0);
      expect(result.transactions.total).toBe(0);
      expect(dataSource.query).toHaveBeenCalledWith(
        expect.stringContaining('FROM member_master'),
        expect.any(Array),
      );
    });

    it('should search both loans and deposits when entityType is ACCOUNT', async () => {
      mockDataSource.query.mockImplementation((sql: string) =>
        sql.includes('COUNT(*)') ? Promise.resolve([{ count: 0 }]) : Promise.resolve([]),
      );

      const searchDto = {
        query: '123',
        entityType: SearchEntityType.ACCOUNT,
        page: 1,
        limit: 10,
      };

      const result = await service.globalSearch(searchDto);

      expect(result.members.total).toBe(0);
      expect(result.transactions.total).toBe(0);
      expect(dataSource.query).toHaveBeenCalledWith(
        expect.stringContaining('FROM loan_master'),
        expect.any(Array),
      );
      expect(dataSource.query).toHaveBeenCalledWith(
        expect.stringContaining('FROM fdmaster'),
        expect.any(Array),
      );
    });
  });

  describe('searchMembers', () => {
    it('should query member_master with the search term', async () => {
      mockDataSource.query.mockImplementation((sql: string) =>
        sql.includes('COUNT(*)') ? Promise.resolve([{ count: 1 }]) : Promise.resolve([{ mbno: '1', name: 'John Doe' }]),
      );

      const result = await service.searchMembers({ query: 'John', page: 1, limit: 10 });

      expect(result).toHaveProperty('data');
      expect(result).toHaveProperty('total', 1);
      expect(result).toHaveProperty('page', 1);
      expect(result).toHaveProperty('limit', 10);
      expect(dataSource.query).toHaveBeenCalledWith(
        expect.stringContaining('FROM member_master'),
        ['%John%'],
      );
    });

    it('should apply member number filter', async () => {
      mockDataSource.query.mockImplementation((sql: string) =>
        sql.includes('COUNT(*)') ? Promise.resolve([{ count: 0 }]) : Promise.resolve([]),
      );

      await service.searchMembers({ memberNumber: 'M001', page: 1, limit: 10 });

      expect(dataSource.query).toHaveBeenCalledWith(
        expect.stringContaining('m.mbno::text ILIKE $1'),
        ['%M001%'],
      );
    });
  });

  describe('searchLoans', () => {
    it('should query loan_master joined to member_master', async () => {
      mockDataSource.query.mockImplementation((sql: string) =>
        sql.includes('COUNT(*)') ? Promise.resolve([{ count: 0 }]) : Promise.resolve([]),
      );

      const result = await service.searchLoans({ query: 'loan', page: 1, limit: 10 });

      expect(result).toHaveProperty('data');
      expect(result).toHaveProperty('total');
      expect(dataSource.query).toHaveBeenCalledWith(
        expect.stringContaining('FROM loan_master l'),
        expect.any(Array),
      );
      expect(dataSource.query).toHaveBeenCalledWith(
        expect.stringContaining('LEFT JOIN member_master m ON l.mbno = m.mbno'),
        expect.any(Array),
      );
    });

    it('should apply account number filter', async () => {
      mockDataSource.query.mockImplementation((sql: string) =>
        sql.includes('COUNT(*)') ? Promise.resolve([{ count: 0 }]) : Promise.resolve([]),
      );

      await service.searchLoans({ accountNumber: '555', page: 1, limit: 10 });

      expect(dataSource.query).toHaveBeenCalledWith(
        expect.stringContaining('l.loancaseno::text ILIKE $1'),
        ['%555%'],
      );
    });
  });

  describe('searchDeposits', () => {
    it('should query fdmaster joined to member_master', async () => {
      mockDataSource.query.mockImplementation((sql: string) =>
        sql.includes('COUNT(*)') ? Promise.resolve([{ count: 0 }]) : Promise.resolve([]),
      );

      const result = await service.searchDeposits({ query: 'deposit', page: 1, limit: 10 });

      expect(result).toHaveProperty('data');
      expect(result).toHaveProperty('total');
      expect(dataSource.query).toHaveBeenCalledWith(
        expect.stringContaining('FROM fdmaster f'),
        expect.any(Array),
      );
    });
  });

  describe('searchTransactions', () => {
    it('should search transactions with member join', async () => {
      const filters = {
        query: 'payment',
        page: 1,
        limit: 10,
      };

      const result = await service.searchTransactions(filters);

      expect(result).toHaveProperty('data');
      expect(result).toHaveProperty('total');
      expect(transactionRepository.createQueryBuilder).toHaveBeenCalledWith('transaction');
      expect(mockQueryBuilder.leftJoinAndSelect).toHaveBeenCalledWith('transaction.member', 'member');
    });

    it('should apply amount range filters', async () => {
      const filters = {
        amountFrom: 1000,
        amountTo: 5000,
        page: 1,
        limit: 10,
      };

      await service.searchTransactions(filters);

      expect(mockQueryBuilder.andWhere).toHaveBeenCalledWith(
        'transaction.amount >= :amountFrom',
        { amountFrom: 1000 }
      );
      expect(mockQueryBuilder.andWhere).toHaveBeenCalledWith(
        'transaction.amount <= :amountTo',
        { amountTo: 5000 }
      );
    });
  });
});
