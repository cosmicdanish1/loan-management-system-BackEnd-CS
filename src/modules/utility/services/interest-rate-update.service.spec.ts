import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Repository, DataSource } from 'typeorm';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { InterestRateUpdateService, InterestRateUpdateDto } from './interest-rate-update.service';
import { LoanAccount } from '../../loan/entities/loan-account.entity';
import { FixedDeposit } from '../../deposit/entities/fixed-deposit.entity';
import { InterestRate, InterestRateType } from '../../admin/entities/interest-rate.entity';
import { SystemConfigService } from '../../admin/services/system-config.service';

describe('InterestRateUpdateService', () => {
  let service: InterestRateUpdateService;
  let loanRepository: Repository<LoanAccount>;
  let depositRepository: Repository<FixedDeposit>;
  let interestRateRepository: Repository<InterestRate>;
  let systemConfigService: SystemConfigService;
  let dataSource: DataSource;

  const mockQueryRunner = {
    connect: jest.fn(),
    startTransaction: jest.fn(),
    commitTransaction: jest.fn(),
    rollbackTransaction: jest.fn(),
    release: jest.fn(),
    manager: {
      create: jest.fn(),
      save: jest.fn(),
      update: jest.fn(),
      createQueryBuilder: jest.fn(() => ({
        update: jest.fn().mockReturnThis(),
        set: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        execute: jest.fn().mockResolvedValue({ affected: 5 }),
      })),
    },
  };

  const mockQueryBuilder = {
    leftJoinAndSelect: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    andWhere: jest.fn().mockReturnThis(),
    orderBy: jest.fn().mockReturnThis(),
    getMany: jest.fn(),
    getOne: jest.fn(),
  };

  const mockRepository = {
    find: jest.fn(),
    findOne: jest.fn(),
    save: jest.fn(),
    create: jest.fn(),
    createQueryBuilder: jest.fn().mockReturnValue(mockQueryBuilder),
  };

  const mockDataSource = {
    createQueryRunner: jest.fn().mockReturnValue(mockQueryRunner),
  };

  const mockSystemConfigService = {
    getConfig: jest.fn(),
    updateConfig: jest.fn(),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        InterestRateUpdateService,
        {
          provide: getRepositoryToken(LoanAccount),
          useValue: mockRepository,
        },
        {
          provide: getRepositoryToken(FixedDeposit),
          useValue: mockRepository,
        },
        {
          provide: getRepositoryToken(InterestRate),
          useValue: mockRepository,
        },
        {
          provide: SystemConfigService,
          useValue: mockSystemConfigService,
        },
        {
          provide: DataSource,
          useValue: mockDataSource,
        },
      ],
    }).compile();

    service = module.get<InterestRateUpdateService>(InterestRateUpdateService);
    loanRepository = module.get<Repository<LoanAccount>>(getRepositoryToken(LoanAccount));
    depositRepository = module.get<Repository<FixedDeposit>>(getRepositoryToken(FixedDeposit));
    interestRateRepository = module.get<Repository<InterestRate>>(getRepositoryToken(InterestRate));
    systemConfigService = module.get<SystemConfigService>(SystemConfigService);
    dataSource = module.get<DataSource>(DataSource);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('updateInterestRates', () => {
    const validUpdateDto: InterestRateUpdateDto = {
      rateType: InterestRateType.LOAN,
      newRate: 12.5,
      effectiveDate: new Date('2024-01-01'),
      applyToExisting: true,
    };

    it('should update interest rates successfully', async () => {
      mockQueryRunner.manager.create.mockReturnValue({ id: 1, type: InterestRateType.LOAN });
      mockQueryRunner.manager.save.mockResolvedValue({ id: 1 });

      const result = await service.updateInterestRates(validUpdateDto);

      expect(result.success).toBe(true);
      expect(result.affectedAccounts).toBe(5);
      expect(mockQueryRunner.startTransaction).toHaveBeenCalled();
      expect(mockQueryRunner.commitTransaction).toHaveBeenCalled();
    });

    it('should validate interest rate bounds', async () => {
      const invalidUpdateDto = { ...validUpdateDto, newRate: 150 };

      const result = await service.updateInterestRates(invalidUpdateDto);

      expect(result.success).toBe(false);
      expect(result.message).toContain('Interest rate must be between 0 and 100');
    });

    it('should handle negative interest rates', async () => {
      const invalidUpdateDto = { ...validUpdateDto, newRate: -5 };

      const result = await service.updateInterestRates(invalidUpdateDto);

      expect(result.success).toBe(false);
      expect(result.message).toContain('Interest rate must be between 0 and 100');
    });

    it('should warn about unusually high loan rates', async () => {
      const highRateDto = { ...validUpdateDto, newRate: 60 };

      const result = await service.updateInterestRates(highRateDto);

      expect(result.success).toBe(false);
      expect(result.message).toContain('Loan interest rate seems unusually high');
    });

    it('should handle transaction rollback on error', async () => {
      mockQueryRunner.manager.save.mockRejectedValue(new Error('Database error'));

      const result = await service.updateInterestRates(validUpdateDto);

      expect(result.success).toBe(false);
      expect(mockQueryRunner.rollbackTransaction).toHaveBeenCalled();
      expect(mockQueryRunner.release).toHaveBeenCalled();
    });

    it('should update only specified account IDs', async () => {
      const specificAccountsDto = {
        ...validUpdateDto,
        accountIds: [1, 2, 3],
      };

      mockQueryRunner.manager.create.mockReturnValue({ id: 1 });
      mockQueryRunner.manager.save.mockResolvedValue({ id: 1 });

      const result = await service.updateInterestRates(specificAccountsDto);

      expect(result.success).toBe(true);
      expect(result.updatedAccounts).toEqual([1, 2, 3]);
    });
  });

  describe('bulkUpdateInterestRates', () => {
    it('should update multiple rate types', async () => {
      const bulkUpdate = {
        loanRates: { PERSONAL: 12.5, BUSINESS: 15.0 },
        depositRates: { FIXED: 8.0, RECURRING: 7.5 },
        effectiveDate: new Date('2024-01-01'),
        applyToExisting: true,
      };

      mockQueryRunner.manager.create.mockReturnValue({ id: 1 });
      mockQueryRunner.manager.save.mockResolvedValue({ id: 1 });

      const results = await service.bulkUpdateInterestRates(bulkUpdate);

      expect(results).toHaveLength(4); // 2 loan rates + 2 deposit rates
      expect(results.every(r => r.success)).toBe(true);
    });

    it('should handle partial failures in bulk update', async () => {
      const bulkUpdate = {
        loanRates: { PERSONAL: 12.5, BUSINESS: 150 }, // Second rate is invalid
        effectiveDate: new Date('2024-01-01'),
        applyToExisting: true,
      };

      const results = await service.bulkUpdateInterestRates(bulkUpdate);

      expect(results).toHaveLength(2);
      expect(results[0].success).toBe(true);
      expect(results[1].success).toBe(false);
    });
  });

  describe('getCurrentInterestRates', () => {
    it('should return current active rates summary', async () => {
      const mockRates = [
        { id: 1, type: InterestRateType.LOAN, rate: 12.5, isActive: true, updatedAt: new Date() },
        { id: 2, type: InterestRateType.FIXED_DEPOSIT, rate: 8.0, isActive: true, updatedAt: new Date() },
      ];

      interestRateRepository.find = jest.fn().mockResolvedValue(mockRates);

      const result = await service.getCurrentInterestRates();

      expect(result.loanRates).toHaveLength(1);
      expect(result.depositRates).toHaveLength(1);
      expect(result.lastUpdated).toBeDefined();
    });

    it('should handle empty rates', async () => {
      interestRateRepository.find = jest.fn().mockResolvedValue([]);

      const result = await service.getCurrentInterestRates();

      expect(result.loanRates).toHaveLength(0);
      expect(result.depositRates).toHaveLength(0);
      expect(result.lastUpdated).toBeNull();
    });
  });

  describe('recalculateInterestForAccounts', () => {
    it('should recalculate loan interest successfully', async () => {
      const mockLoan = {
        id: 1,
        accountNumber: 'L001',
        interestRate: 12.5,
        outstandingBalance: 50000,
      };

      loanRepository.findOne = jest.fn().mockResolvedValue(mockLoan);
      loanRepository.save = jest.fn().mockResolvedValue(mockLoan);

      const result = await service.recalculateInterestForAccounts('loan', [1], new Date());

      expect(result.success).toBe(true);
      expect(result.recalculatedAccounts).toBe(1);
      expect(result.errors).toHaveLength(0);
    });

    it('should recalculate deposit interest successfully', async () => {
      const mockDeposit = {
        id: 1,
        accountNumber: 'FD001',
        principalAmount: 100000,
        interestRate: 8.0,
        depositDate: new Date('2024-01-01'),
        maturityDate: new Date('2025-01-01'),
        maturityAmount: 108000,
      };

      depositRepository.findOne = jest.fn().mockResolvedValue(mockDeposit);
      depositRepository.save = jest.fn().mockResolvedValue(mockDeposit);

      const result = await service.recalculateInterestForAccounts('deposit', [1], new Date());

      expect(result.success).toBe(true);
      expect(result.recalculatedAccounts).toBe(1);
      expect(result.errors).toHaveLength(0);
    });

    it('should handle missing accounts gracefully', async () => {
      loanRepository.findOne = jest.fn().mockResolvedValue(null);

      const result = await service.recalculateInterestForAccounts('loan', [999], new Date());

      expect(result.success).toBe(false);
      expect(result.recalculatedAccounts).toBe(0);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]).toContain('Loan 999: Loan account 999 not found');
    });

    it('should handle multiple accounts with mixed results', async () => {
      const mockLoan = { id: 1, accountNumber: 'L001' };
      
      loanRepository.findOne = jest.fn()
        .mockResolvedValueOnce(mockLoan)
        .mockResolvedValueOnce(null);
      loanRepository.save = jest.fn().mockResolvedValue(mockLoan);

      const result = await service.recalculateInterestForAccounts('loan', [1, 999], new Date());

      expect(result.success).toBe(false);
      expect(result.recalculatedAccounts).toBe(1);
      expect(result.errors).toHaveLength(1);
    });
  });

  describe('previewInterestRateUpdate', () => {
    it('should calculate preview for loan rate update', async () => {
      const mockLoans = [
        {
          id: 1,
          accountNumber: 'L001',
          interestRate: 10.0,
          outstandingBalance: 50000,
          member: { firstName: 'John', lastName: 'Doe' },
        },
        {
          id: 2,
          accountNumber: 'L002',
          interestRate: 12.0,
          outstandingBalance: 75000,
          member: { firstName: 'Jane', lastName: 'Smith' },
        },
      ];

      mockQueryBuilder.getMany.mockResolvedValue(mockLoans);

      const updateDto: InterestRateUpdateDto = {
        rateType: InterestRateType.LOAN,
        newRate: 11.0,
        effectiveDate: new Date(),
        applyToExisting: true,
      };

      const result = await service.previewInterestRateUpdate(updateDto);

      expect(result.affectedAccountsCount).toBe(2);
      expect(result.estimatedImpact).toHaveLength(2);
      expect(result.estimatedImpact[0].rateDifference).toBe(1.0); // 11.0 - 10.0
      expect(result.estimatedImpact[0].estimatedAnnualImpact).toBe(500); // 50000 * 1% / 100
      expect(result.estimatedImpact[1].rateDifference).toBe(-1.0); // 11.0 - 12.0
      expect(result.estimatedImpact[1].estimatedAnnualImpact).toBe(-750); // 75000 * -1% / 100
    });

    it('should filter by amount range', async () => {
      const mockDeposits = [
        {
          id: 1,
          accountNumber: 'FD001',
          interestRate: 8.0,
          principalAmount: 100000,
          member: { firstName: 'John', lastName: 'Doe' },
        },
      ];

      mockQueryBuilder.getMany.mockResolvedValue(mockDeposits);

      const updateDto: InterestRateUpdateDto = {
        rateType: InterestRateType.FIXED_DEPOSIT,
        newRate: 9.0,
        effectiveDate: new Date(),
        applyToExisting: true,
        minAmount: 50000,
        maxAmount: 200000,
      };

      const result = await service.previewInterestRateUpdate(updateDto);

      expect(result.affectedAccountsCount).toBe(1);
      expect(mockQueryBuilder.andWhere).toHaveBeenCalledWith(
        'fd.principalAmount >= :minAmount',
        { minAmount: 50000 }
      );
      expect(mockQueryBuilder.andWhere).toHaveBeenCalledWith(
        'fd.principalAmount <= :maxAmount',
        { maxAmount: 200000 }
      );
    });

    it('should handle preview calculation errors', async () => {
      mockQueryBuilder.getMany.mockRejectedValue(new Error('Database error'));

      const updateDto: InterestRateUpdateDto = {
        rateType: InterestRateType.LOAN,
        newRate: 12.0,
        effectiveDate: new Date(),
        applyToExisting: true,
      };

      await expect(service.previewInterestRateUpdate(updateDto)).rejects.toThrow(BadRequestException);
    });
  });

  describe('Edge cases and validation', () => {
    it('should handle zero interest rate', async () => {
      const zeroRateDto: InterestRateUpdateDto = {
        rateType: InterestRateType.LOAN,
        newRate: 0,
        effectiveDate: new Date(),
        applyToExisting: true,
      };

      mockQueryRunner.manager.create.mockReturnValue({ id: 1 });
      mockQueryRunner.manager.save.mockResolvedValue({ id: 1 });

      const result = await service.updateInterestRates(zeroRateDto);

      expect(result.success).toBe(true);
    });

    it('should validate deposit rate bounds', async () => {
      const highDepositRateDto: InterestRateUpdateDto = {
        rateType: InterestRateType.FIXED_DEPOSIT,
        newRate: 25,
        effectiveDate: new Date(),
        applyToExisting: true,
      };

      const result = await service.updateInterestRates(highDepositRateDto);

      expect(result.success).toBe(false);
      expect(result.message).toContain('Deposit interest rate seems unusually high');
    });

    it('should handle empty account IDs array', async () => {
      const emptyAccountsDto: InterestRateUpdateDto = {
        rateType: InterestRateType.LOAN,
        newRate: 12.0,
        effectiveDate: new Date(),
        applyToExisting: true,
        accountIds: [],
      };

      mockQueryRunner.manager.create.mockReturnValue({ id: 1 });
      mockQueryRunner.manager.save.mockResolvedValue({ id: 1 });

      const result = await service.updateInterestRates(emptyAccountsDto);

      expect(result.success).toBe(true);
    });
  });
});
