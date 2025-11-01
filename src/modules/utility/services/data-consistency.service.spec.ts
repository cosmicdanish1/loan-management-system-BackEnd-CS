import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Repository, DataSource } from 'typeorm';
import { DataConsistencyService, ConsistencyCheckResult, DataConsistencyReport } from './data-consistency.service';
import { Member } from '../../member/entities/member.entity';
import { LoanAccount } from '../../loan/entities/loan-account.entity';
import { LoanPayment } from '../../loan/entities/loan-payment.entity';
import { FixedDeposit } from '../../deposit/entities/fixed-deposit.entity';
import { Transaction } from '../../transaction/entities/transaction.entity';

describe('DataConsistencyService', () => {
  let service: DataConsistencyService;
  let memberRepository: Repository<Member>;
  let loanAccountRepository: Repository<LoanAccount>;
  let loanPaymentRepository: Repository<LoanPayment>;
  let fixedDepositRepository: Repository<FixedDeposit>;
  let transactionRepository: Repository<Transaction>;
  let dataSource: DataSource;

  const mockQueryBuilder = {
    leftJoin: jest.fn().mockReturnThis(),
    leftJoinAndSelect: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    andWhere: jest.fn().mockReturnThis(),
    orWhere: jest.fn().mockReturnThis(),
    select: jest.fn().mockReturnThis(),
    groupBy: jest.fn().mockReturnThis(),
    having: jest.fn().mockReturnThis(),
    orderBy: jest.fn().mockReturnThis(),
    getMany: jest.fn(),
    getOne: jest.fn(),
    getRawMany: jest.fn(),
    getRawOne: jest.fn(),
  };

  const mockRepository = {
    find: jest.fn(),
    findOne: jest.fn(),
    createQueryBuilder: jest.fn().mockReturnValue(mockQueryBuilder),
  };

  const mockDataSource = {
    createQueryRunner: jest.fn(),
    query: jest.fn(),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        DataConsistencyService,
        {
          provide: getRepositoryToken(Member),
          useValue: mockRepository,
        },
        {
          provide: getRepositoryToken(LoanAccount),
          useValue: mockRepository,
        },
        {
          provide: getRepositoryToken(LoanPayment),
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
        {
          provide: DataSource,
          useValue: mockDataSource,
        },
      ],
    }).compile();

    service = module.get<DataConsistencyService>(DataConsistencyService);
    memberRepository = module.get<Repository<Member>>(getRepositoryToken(Member));
    loanAccountRepository = module.get<Repository<LoanAccount>>(getRepositoryToken(LoanAccount));
    loanPaymentRepository = module.get<Repository<LoanPayment>>(getRepositoryToken(LoanPayment));
    fixedDepositRepository = module.get<Repository<FixedDeposit>>(getRepositoryToken(FixedDeposit));
    transactionRepository = module.get<Repository<Transaction>>(getRepositoryToken(Transaction));
    dataSource = module.get<DataSource>(DataSource);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('runConsistencyChecks', () => {
    it('should run all consistency checks and return healthy status', async () => {
      // Mock all checks to return no issues
      mockQueryBuilder.getMany.mockResolvedValue([]);
      mockQueryBuilder.getRawMany.mockResolvedValue([]);

      const result = await service.runConsistencyChecks();

      expect(result).toBeDefined();
      expect(result.overallStatus).toBe('HEALTHY');
      expect(result.totalChecks).toBeGreaterThan(0);
      expect(result.passedChecks).toBe(result.totalChecks);
      expect(result.failedChecks).toBe(0);
      expect(result.warningChecks).toBe(0);
      expect(Array.isArray(result.checks)).toBe(true);
      expect(result.generatedAt).toBeInstanceOf(Date);
      expect(Array.isArray(result.recommendations)).toBe(true);
    });

    it('should detect critical issues and return appropriate status', async () => {
      // Mock orphaned records check to return issues
      mockQueryBuilder.getMany
        .mockResolvedValueOnce([{ id: 1, accountNumber: 'L001' }]) // orphaned loans
        .mockResolvedValueOnce([]) // orphaned deposits
        .mockResolvedValueOnce([]) // orphaned payments
        .mockResolvedValueOnce([]); // orphaned transactions

      // Mock other checks to return no issues
      mockQueryBuilder.getRawMany.mockResolvedValue([]);

      const result = await service.runConsistencyChecks();

      expect(result.overallStatus).toBe('CRITICAL_ISSUES');
      expect(result.failedChecks).toBeGreaterThan(0);
    });
  });

  describe('checkOrphanedRecords', () => {
    it('should pass when no orphaned records exist', async () => {
      mockQueryBuilder.getMany.mockResolvedValue([]);

      const result = await service.checkOrphanedRecords();

      expect(result.checkName).toBe('Orphaned Records Check');
      expect(result.status).toBe('PASS');
      expect(result.affectedRecords).toBe(0);
      expect(result.fixAvailable).toBe(true);
    });

    it('should fail when orphaned records exist', async () => {
      const orphanedLoan = { id: 1, accountNumber: 'L001' };
      mockQueryBuilder.getMany
        .mockResolvedValueOnce([orphanedLoan])
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([]);

      const result = await service.checkOrphanedRecords();

      expect(result.status).toBe('FAIL');
      expect(result.affectedRecords).toBe(1);
      expect(result.details).toBeDefined();
    });
  });

  describe('checkBalanceConsistency', () => {
    it('should pass when balances are consistent', async () => {
      const mockLoan = {
        id: 1,
        principalAmount: 100000,
        outstandingBalance: 80000,
        payments: [{ amount: 20000 }],
        member: { id: 1, firstName: 'John', lastName: 'Doe' },
      };

      loanAccountRepository.find = jest.fn().mockResolvedValue([mockLoan]);

      const result = await service.checkBalanceConsistency();

      expect(result.checkName).toBe('Balance Consistency Check');
      expect(result.status).toBe('PASS');
      expect(result.affectedRecords).toBe(0);
    });

    it('should fail when balance discrepancies exist', async () => {
      const mockLoan = {
        id: 1,
        principalAmount: 100000,
        outstandingBalance: 70000, // Incorrect balance
        payments: [{ amount: 20000 }],
        member: { id: 1, firstName: 'John', lastName: 'Doe' },
        disbursementDate: new Date(),
      };

      loanAccountRepository.find = jest.fn().mockResolvedValue([mockLoan]);

      const result = await service.checkBalanceConsistency();

      expect(result.status).toBe('FAIL');
      expect(result.affectedRecords).toBe(1);
      expect(result.details).toBeDefined();
    });
  });

  describe('checkDuplicateRecords', () => {
    it('should pass when no duplicates exist', async () => {
      mockQueryBuilder.getRawMany.mockResolvedValue([]);

      const result = await service.checkDuplicateRecords();

      expect(result.checkName).toBe('Duplicate Records Check');
      expect(result.status).toBe('PASS');
      expect(result.affectedRecords).toBe(0);
    });

    it('should warn when duplicates exist', async () => {
      mockQueryBuilder.getRawMany
        .mockResolvedValueOnce([{ phoneNumber: '1234567890', count: 2 }])
        .mockResolvedValueOnce([]);

      const result = await service.checkDuplicateRecords();

      expect(result.status).toBe('WARNING');
      expect(result.affectedRecords).toBe(2);
    });
  });

  describe('checkDataIntegrity', () => {
    it('should pass when data integrity is maintained', async () => {
      mockQueryBuilder.getMany.mockResolvedValue([]);

      const result = await service.checkDataIntegrity();

      expect(result.checkName).toBe('Data Integrity Check');
      expect(result.status).toBe('PASS');
      expect(result.affectedRecords).toBe(0);
    });

    it('should fail when data integrity issues exist', async () => {
      const memberWithMissingData = {
        id: 1,
        memberNumber: 'M001',
        firstName: '',
        lastName: 'Doe',
        phoneNumber: null,
      };

      mockQueryBuilder.getMany
        .mockResolvedValueOnce([memberWithMissingData])
        .mockResolvedValueOnce([]);

      const result = await service.checkDataIntegrity();

      expect(result.status).toBe('FAIL');
      expect(result.affectedRecords).toBe(1);
    });
  });

  describe('checkBusinessRuleViolations', () => {
    it('should pass when no business rule violations exist', async () => {
      mockQueryBuilder.getMany.mockResolvedValue([]);

      const result = await service.checkBusinessRuleViolations();

      expect(result.checkName).toBe('Business Rule Violations Check');
      expect(result.status).toBe('PASS');
      expect(result.affectedRecords).toBe(0);
    });

    it('should fail when business rule violations exist', async () => {
      const loanWithInvalidDates = {
        id: 1,
        accountNumber: 'L001',
        disbursementDate: new Date('2024-01-15'),
        maturityDate: new Date('2024-01-10'), // Before disbursement
      };

      mockQueryBuilder.getMany
        .mockResolvedValueOnce([loanWithInvalidDates])
        .mockResolvedValueOnce([]);

      const result = await service.checkBusinessRuleViolations();

      expect(result.status).toBe('FAIL');
      expect(result.affectedRecords).toBe(1);
    });
  });

  describe('checkReferentialIntegrity', () => {
    it('should pass when referential integrity is maintained', async () => {
      mockQueryBuilder.getMany.mockResolvedValue([]);

      const result = await service.checkReferentialIntegrity();

      expect(result.checkName).toBe('Referential Integrity Check');
      expect(result.status).toBe('PASS');
      expect(result.affectedRecords).toBe(0);
    });

    it('should warn when referential integrity issues exist', async () => {
      const loanWithInactiveMember = {
        id: 1,
        accountNumber: 'L001',
        member: { id: 1 },
      };

      mockQueryBuilder.getMany.mockResolvedValue([loanWithInactiveMember]);

      const result = await service.checkReferentialIntegrity();

      expect(result.status).toBe('WARNING');
      expect(result.affectedRecords).toBe(1);
    });
  });

  describe('checkDateConsistency', () => {
    it('should pass when dates are consistent', async () => {
      mockQueryBuilder.getMany.mockResolvedValue([]);

      const result = await service.checkDateConsistency();

      expect(result.checkName).toBe('Date Consistency Check');
      expect(result.status).toBe('PASS');
      expect(result.affectedRecords).toBe(0);
    });

    it('should warn when date inconsistencies exist', async () => {
      const futureDatedTransaction = {
        id: 1,
        transactionNumber: 'T001',
        transactionDate: new Date('2025-12-31'),
      };

      mockQueryBuilder.getMany.mockResolvedValue([futureDatedTransaction]);

      const result = await service.checkDateConsistency();

      expect(result.status).toBe('WARNING');
      expect(result.affectedRecords).toBe(1);
    });
  });

  describe('checkNumericalConsistency', () => {
    it('should pass when numerical values are consistent', async () => {
      mockQueryBuilder.getMany.mockResolvedValue([]);

      const result = await service.checkNumericalConsistency();

      expect(result.checkName).toBe('Numerical Consistency Check');
      expect(result.status).toBe('PASS');
      expect(result.affectedRecords).toBe(0);
    });

    it('should fail when numerical inconsistencies exist', async () => {
      const depositWithNegativeAmount = {
        id: 1,
        accountNumber: 'FD001',
        principalAmount: -1000,
        maturityAmount: 1100,
      };

      mockQueryBuilder.getMany.mockResolvedValue([depositWithNegativeAmount]);

      const result = await service.checkNumericalConsistency();

      expect(result.status).toBe('FAIL');
      expect(result.affectedRecords).toBe(1);
    });
  });

  describe('error handling', () => {
    it('should handle errors gracefully in consistency checks', async () => {
      mockQueryBuilder.getMany.mockRejectedValue(new Error('Database error'));

      const result = await service.checkOrphanedRecords();

      expect(result.status).toBe('FAIL');
      expect(result.message).toContain('Check failed');
      expect(result.fixAvailable).toBe(false);
    });
  });
});
