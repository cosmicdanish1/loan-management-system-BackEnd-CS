import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { SearchService } from './search.service';
import { Member } from '../../member/entities/member.entity';
import { LoanAccount } from '../../loan/entities/loan-account.entity';
import { FixedDeposit } from '../../deposit/entities/fixed-deposit.entity';
import { Transaction } from '../../transaction/entities/transaction.entity';
import { SearchEntityType } from '../dto/search.dto';

describe('SearchService', () => {
  let service: SearchService;
  let memberRepository: Repository<Member>;
  let loanRepository: Repository<LoanAccount>;
  let depositRepository: Repository<FixedDeposit>;
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

  const mockRepository = {
    createQueryBuilder: jest.fn().mockReturnValue(mockQueryBuilder),
    find: jest.fn(),
    findOne: jest.fn(),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SearchService,
        {
          provide: getRepositoryToken(Member),
          useValue: mockRepository,
        },
        {
          provide: getRepositoryToken(LoanAccount),
          useValue: mockRepository,
        },
        {
          provide: getRepositoryToken(FixedDeposit),
          useValue: mockRepository,
        },
        {
          provide: getRepositoryToken(Transaction),
          useValue: mockRepository,
        },
      ],
    }).compile();

    service = module.get<SearchService>(SearchService);
    memberRepository = module.get<Repository<Member>>(getRepositoryToken(Member));
    loanRepository = module.get<Repository<LoanAccount>>(getRepositoryToken(LoanAccount));
    depositRepository = module.get<Repository<FixedDeposit>>(getRepositoryToken(FixedDeposit));
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
      expect(memberRepository.createQueryBuilder).toHaveBeenCalled();
      expect(loanRepository.createQueryBuilder).toHaveBeenCalled();
      expect(depositRepository.createQueryBuilder).toHaveBeenCalled();
      expect(transactionRepository.createQueryBuilder).toHaveBeenCalled();
    });

    it('should search only members when entityType is MEMBER', async () => {
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
      expect(memberRepository.createQueryBuilder).toHaveBeenCalled();
    });
  });

  describe('searchMembers', () => {
    it('should search members with filters', async () => {
      const filters = {
        query: 'John',
        page: 1,
        limit: 10,
      };

      const result = await service.searchMembers(filters);

      expect(result).toHaveProperty('data');
      expect(result).toHaveProperty('total');
      expect(result).toHaveProperty('page', 1);
      expect(result).toHaveProperty('limit', 10);
      expect(memberRepository.createQueryBuilder).toHaveBeenCalledWith('member');
    });

    it('should apply member number filter', async () => {
      const filters = {
        memberNumber: 'M001',
        page: 1,
        limit: 10,
      };

      await service.searchMembers(filters);

      expect(mockQueryBuilder.andWhere).toHaveBeenCalledWith(
        'member.memberNumber ILIKE :memberNumber',
        { memberNumber: '%M001%' }
      );
    });
  });

  describe('searchLoans', () => {
    it('should search loans with member join', async () => {
      const filters = {
        query: 'loan',
        page: 1,
        limit: 10,
      };

      const result = await service.searchLoans(filters);

      expect(result).toHaveProperty('data');
      expect(result).toHaveProperty('total');
      expect(loanRepository.createQueryBuilder).toHaveBeenCalledWith('loan');
      expect(mockQueryBuilder.leftJoinAndSelect).toHaveBeenCalledWith('loan.member', 'member');
    });

    it('should apply loan type filter', async () => {
      const filters = {
        loanType: 'PERSONAL',
        page: 1,
        limit: 10,
      };

      await service.searchLoans(filters);

      expect(mockQueryBuilder.andWhere).toHaveBeenCalledWith(
        'loan.loanType = :loanType',
        { loanType: 'PERSONAL' }
      );
    });
  });

  describe('searchDeposits', () => {
    it('should search deposits with member join', async () => {
      const filters = {
        query: 'deposit',
        page: 1,
        limit: 10,
      };

      const result = await service.searchDeposits(filters);

      expect(result).toHaveProperty('data');
      expect(result).toHaveProperty('total');
      expect(depositRepository.createQueryBuilder).toHaveBeenCalledWith('deposit');
      expect(mockQueryBuilder.leftJoinAndSelect).toHaveBeenCalledWith('deposit.member', 'member');
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
