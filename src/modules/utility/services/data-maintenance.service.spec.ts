import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { InterestRateUpdateService } from './interest-rate-update.service';
import { DataConsistencyService } from './data-consistency.service';
import { DataCorrectionService } from './data-correction.service';
import { SystemHealthMonitoringService } from './system-health-monitoring.service';
import { Member } from '../../member/entities/member.entity';
import { LoanAccount } from '../../loan/entities/loan-account.entity';
import { LoanPayment } from '../../loan/entities/loan-payment.entity';
import { FixedDeposit } from '../../deposit/entities/fixed-deposit.entity';
import { Transaction } from '../../transaction/entities/transaction.entity';
import { InterestRate } from '../../admin/entities/interest-rate.entity';
import { SystemConfigService } from '../../admin/services/system-config.service';

describe('Data Maintenance Services', () => {
  let interestRateUpdateService: InterestRateUpdateService;
  let dataConsistencyService: DataConsistencyService;
  let dataCorrectionService: DataCorrectionService;
  let systemHealthMonitoringService: SystemHealthMonitoringService;

  const mockRepository = {
    find: jest.fn(),
    findOne: jest.fn(),
    save: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
    delete: jest.fn(),
    count: jest.fn(),
    createQueryBuilder: jest.fn(() => ({
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
      execute: jest.fn(),
    })),
  };

  const mockDataSource = {
    createQueryRunner: jest.fn(() => ({
      connect: jest.fn(),
      startTransaction: jest.fn(),
      commitTransaction: jest.fn(),
      rollbackTransaction: jest.fn(),
      release: jest.fn(),
      manager: {
        find: jest.fn(),
        findOne: jest.fn(),
        save: jest.fn(),
        create: jest.fn(),
        update: jest.fn(),
        delete: jest.fn(),
        createQueryBuilder: jest.fn(() => mockRepository.createQueryBuilder()),
      },
    })),
    query: jest.fn(),
    isInitialized: true,
  };

  const mockSystemConfigService = {
    getConfig: jest.fn(),
    updateConfig: jest.fn(),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        InterestRateUpdateService,
        DataConsistencyService,
        DataCorrectionService,
        SystemHealthMonitoringService,
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
          provide: getRepositoryToken(InterestRate),
          useValue: mockRepository,
        },
        {
          provide: DataSource,
          useValue: mockDataSource,
        },
        {
          provide: SystemConfigService,
          useValue: mockSystemConfigService,
        },
      ],
    }).compile();

    interestRateUpdateService = module.get<InterestRateUpdateService>(InterestRateUpdateService);
    dataConsistencyService = module.get<DataConsistencyService>(DataConsistencyService);
    dataCorrectionService = module.get<DataCorrectionService>(DataCorrectionService);
    systemHealthMonitoringService = module.get<SystemHealthMonitoringService>(SystemHealthMonitoringService);
  });

  describe('InterestRateUpdateService', () => {
    it('should be defined', () => {
      expect(interestRateUpdateService).toBeDefined();
    });

    it('should get current interest rates', async () => {
      mockRepository.find.mockResolvedValue([
        { id: 1, type: 'LOAN', rate: 12.5, isActive: true },
        { id: 2, type: 'FIXED_DEPOSIT', rate: 8.0, isActive: true },
      ]);

      const result = await interestRateUpdateService.getCurrentInterestRates();
      
      expect(result).toBeDefined();
      expect(result.loanRates).toBeDefined();
      expect(result.depositRates).toBeDefined();
    });
  });

  describe('DataConsistencyService', () => {
    it('should be defined', () => {
      expect(dataConsistencyService).toBeDefined();
    });

    it('should run consistency checks', async () => {
      // Mock empty results for all checks
      mockRepository.createQueryBuilder().getMany.mockResolvedValue([]);
      mockRepository.createQueryBuilder().getRawMany.mockResolvedValue([]);
      mockRepository.count.mockResolvedValue(0);

      const result = await dataConsistencyService.runConsistencyChecks();
      
      expect(result).toBeDefined();
      expect(result.overallStatus).toBeDefined();
      expect(result.checks).toBeDefined();
      expect(Array.isArray(result.checks)).toBe(true);
    });
  });

  describe('DataCorrectionService', () => {
    it('should be defined', () => {
      expect(dataCorrectionService).toBeDefined();
    });

    it('should fix data integrity issues', async () => {
      // Mock the query runner
      const mockQueryRunner = mockDataSource.createQueryRunner();
      mockQueryRunner.manager.createQueryBuilder.mockReturnValue(mockRepository.createQueryBuilder());

      const result = await dataCorrectionService.fixDataIntegrityIssues();
      
      expect(result).toBeDefined();
      expect(result.success).toBeDefined();
      expect(result.message).toBeDefined();
    });
  });

  describe('SystemHealthMonitoringService', () => {
    it('should be defined', () => {
      expect(systemHealthMonitoringService).toBeDefined();
    });

    it('should get current health status', async () => {
      // Mock database query for health check
      mockDataSource.query.mockResolvedValue([{ count: 1 }]);
      mockRepository.count.mockResolvedValue(10);
      mockRepository.createQueryBuilder().getRawOne.mockResolvedValue({ total: 100000 });

      const result = await systemHealthMonitoringService.getCurrentHealthStatus();
      
      expect(result).toBeDefined();
      expect(result.database).toBeDefined();
      expect(result.application).toBeDefined();
      expect(result.system).toBeDefined();
      expect(result.business).toBeDefined();
      expect(result.overall).toBeDefined();
      expect(result.timestamp).toBeDefined();
    });

    it('should get active alerts', () => {
      const alerts = systemHealthMonitoringService.getActiveAlerts();
      
      expect(Array.isArray(alerts)).toBe(true);
    });

    it('should get performance metrics', () => {
      const metrics = systemHealthMonitoringService.getPerformanceMetrics();
      
      expect(Array.isArray(metrics)).toBe(true);
    });
  });
});
