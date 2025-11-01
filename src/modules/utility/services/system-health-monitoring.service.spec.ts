import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Repository, DataSource } from 'typeorm';
import { SystemHealthMonitoringService, SystemHealthMetrics } from './system-health-monitoring.service';
import { Member } from '../../member/entities/member.entity';
import { LoanAccount } from '../../loan/entities/loan-account.entity';
import { FixedDeposit } from '../../deposit/entities/fixed-deposit.entity';
import { Transaction } from '../../transaction/entities/transaction.entity';
import { DataConsistencyService } from './data-consistency.service';

describe('SystemHealthMonitoringService', () => {
  let service: SystemHealthMonitoringService;
  let memberRepository: Repository<Member>;
  let loanRepository: Repository<LoanAccount>;
  let depositRepository: Repository<FixedDeposit>;
  let transactionRepository: Repository<Transaction>;
  let dataConsistencyService: DataConsistencyService;
  let dataSource: DataSource;

  const mockRepository = {
    count: jest.fn(),
    createQueryBuilder: jest.fn(() => ({
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      select: jest.fn().mockReturnThis(),
      getRawOne: jest.fn(),
      getCount: jest.fn(),
    })),
  };

  const mockDataSource = {
    query: jest.fn(),
    isInitialized: true,
    driver: {
      database: 'test_db',
    },
  };

  const mockDataConsistencyService = {
    runConsistencyChecks: jest.fn(),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
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
          provide: getRepositoryToken(FixedDeposit),
          useValue: mockRepository,
        },
        {
          provide: getRepositoryToken(Transaction),
          useValue: mockRepository,
        },
        {
          provide: DataConsistencyService,
          useValue: mockDataConsistencyService,
        },
        {
          provide: DataSource,
          useValue: mockDataSource,
        },
      ],
    }).compile();

    service = module.get<SystemHealthMonitoringService>(SystemHealthMonitoringService);
    memberRepository = module.get<Repository<Member>>(getRepositoryToken(Member));
    loanRepository = module.get<Repository<LoanAccount>>(getRepositoryToken(LoanAccount));
    depositRepository = module.get<Repository<FixedDeposit>>(getRepositoryToken(FixedDeposit));
    transactionRepository = module.get<Repository<Transaction>>(getRepositoryToken(Transaction));
    dataConsistencyService = module.get<DataConsistencyService>(DataConsistencyService);
    dataSource = module.get<DataSource>(DataSource);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('getCurrentHealthStatus', () => {
    beforeEach(() => {
      // Mock database connection check
      mockDataSource.query.mockResolvedValue([{ count: 1 }]);
      
      // Mock repository counts
      mockRepository.count.mockResolvedValue(100);
      
      // Mock query builder results
      mockRepository.createQueryBuilder().getRawOne.mockResolvedValue({ total: 1000000 });
      mockRepository.createQueryBuilder().getCount.mockResolvedValue(50);
      
      // Mock consistency check
      mockDataConsistencyService.runConsistencyChecks.mockResolvedValue({
        overallStatus: 'HEALTHY',
        failedChecks: 0,
        warningChecks: 0,
        checks: [],
      });
    });

    it('should return comprehensive health metrics', async () => {
      const result = await service.getCurrentHealthStatus();

      expect(result).toBeDefined();
      expect(result.database).toBeDefined();
      expect(result.application).toBeDefined();
      expect(result.system).toBeDefined();
      expect(result.business).toBeDefined();
      expect(result.overall).toBeDefined();
      expect(result.timestamp).toBeInstanceOf(Date);
    });

    it('should check database health correctly', async () => {
      const result = await service.getCurrentHealthStatus();

      expect(result.database.connectionStatus).toBe('HEALTHY');
      expect(mockDataSource.query).toHaveBeenCalledWith('SELECT 1 as count');
    });

    it('should handle database connection failure', async () => {
      mockDataSource.query.mockRejectedValue(new Error('Connection failed'));

      const result = await service.getCurrentHealthStatus();

      expect(result.database.connectionStatus).toBe('CRITICAL');
      expect(result.overall.status).toBe('CRITICAL');
    });

    it('should calculate business metrics correctly', async () => {
      // Mock specific counts for business metrics
      memberRepository.count = jest.fn().mockResolvedValue(150);
      loanRepository.count = jest.fn().mockResolvedValue(75);
      depositRepository.count = jest.fn().mockResolvedValue(100);
      
      const mockLoanTotal = { total: '5000000' };
      const mockDepositTotal = { total: '10000000' };
      const mockDailyTransactions = { count: 25 };
      
      mockRepository.createQueryBuilder().getRawOne
        .mockResolvedValueOnce(mockLoanTotal)
        .mockResolvedValueOnce(mockDepositTotal);
      mockRepository.createQueryBuilder().getCount.mockResolvedValue(25);

      const result = await service.getCurrentHealthStatus();

      expect(result.business.totalMembers).toBe(150);
      expect(result.business.activeLoans).toBe(75);
      expect(result.business.activeDeposits).toBe(100);
      expect(result.business.totalLoanAmount).toBe(5000000);
      expect(result.business.totalDepositAmount).toBe(10000000);
      expect(result.business.dailyTransactions).toBe(25);
    });

    it('should calculate system utilization correctly', async () => {
      memberRepository.count = jest.fn().mockResolvedValue(100);
      loanRepository.count = jest.fn().mockResolvedValue(60);
      depositRepository.count = jest.fn().mockResolvedValue(40);

      const result = await service.getCurrentHealthStatus();

      expect(result.business.systemUtilization).toBe(100); // (60 + 40) / 100 * 100
    });

    it('should handle zero members gracefully', async () => {
      memberRepository.count = jest.fn().mockResolvedValue(0);
      loanRepository.count = jest.fn().mockResolvedValue(0);
      depositRepository.count = jest.fn().mockResolvedValue(0);

      const result = await service.getCurrentHealthStatus();

      expect(result.business.totalMembers).toBe(0);
      expect(result.business.systemUtilization).toBe(0);
    });

    it('should detect critical issues from consistency checks', async () => {
      mockDataConsistencyService.runConsistencyChecks.mockResolvedValue({
        overallStatus: 'CRITICAL_ISSUES',
        failedChecks: 3,
        warningChecks: 1,
        checks: [
          { status: 'FAIL', checkName: 'Balance Consistency', affectedRecords: 5 },
          { status: 'FAIL', checkName: 'Data Integrity', affectedRecords: 2 },
        ],
      });

      const result = await service.getCurrentHealthStatus();

      expect(result.database.dataIntegrity.status).toBe('CRITICAL_ISSUES');
      expect(result.database.dataIntegrity.issuesCount).toBe(3);
      expect(result.overall.status).toBe('CRITICAL');
    });

    it('should calculate overall health score correctly', async () => {
      // Mock healthy system
      mockDataSource.query.mockResolvedValue([{ count: 1 }]);
      mockDataConsistencyService.runConsistencyChecks.mockResolvedValue({
        overallStatus: 'HEALTHY',
        failedChecks: 0,
        warningChecks: 0,
        checks: [],
      });

      const result = await service.getCurrentHealthStatus();

      expect(result.overall.score).toBeGreaterThan(80);
      expect(result.overall.status).toBe('HEALTHY');
    });

    it('should provide recommendations for issues', async () => {
      mockDataConsistencyService.runConsistencyChecks.mockResolvedValue({
        overallStatus: 'ISSUES_FOUND',
        failedChecks: 0,
        warningChecks: 2,
        checks: [],
      });

      const result = await service.getCurrentHealthStatus();

      expect(result.overall.recommendations).toBeDefined();
      expect(Array.isArray(result.overall.recommendations)).toBe(true);
    });
  });

  describe('getActiveAlerts', () => {
    it('should return array of active alerts', () => {
      const alerts = service.getActiveAlerts();

      expect(Array.isArray(alerts)).toBe(true);
    });

    it('should include critical system alerts', () => {
      // This would typically check internal alert state
      const alerts = service.getActiveAlerts();

      expect(alerts).toBeDefined();
    });
  });

  describe('getPerformanceMetrics', () => {
    it('should return array of performance metrics', () => {
      const metrics = service.getPerformanceMetrics();

      expect(Array.isArray(metrics)).toBe(true);
    });

    it('should include system performance data', () => {
      const metrics = service.getPerformanceMetrics();

      expect(metrics).toBeDefined();
    });
  });

  describe('System resource monitoring', () => {
    it('should monitor CPU usage', async () => {
      const result = await service.getCurrentHealthStatus();

      expect(result.system.cpu).toBeDefined();
      expect(result.system.cpu.cores).toBeGreaterThan(0);
      expect(result.system.cpu.usage).toBeGreaterThanOrEqual(0);
      expect(result.system.cpu.usage).toBeLessThanOrEqual(100);
    });

    it('should monitor memory usage', async () => {
      const result = await service.getCurrentHealthStatus();

      expect(result.system.memory).toBeDefined();
      expect(result.system.memory.total).toBeGreaterThan(0);
      expect(result.system.memory.used).toBeGreaterThanOrEqual(0);
      expect(result.system.memory.free).toBeGreaterThanOrEqual(0);
      expect(result.system.memory.percentage).toBeGreaterThanOrEqual(0);
      expect(result.system.memory.percentage).toBeLessThanOrEqual(100);
    });

    it('should monitor application memory', async () => {
      const result = await service.getCurrentHealthStatus();

      expect(result.application.memoryUsage).toBeDefined();
      expect(result.application.memoryUsage.used).toBeGreaterThan(0);
      expect(result.application.memoryUsage.total).toBeGreaterThan(0);
      expect(result.application.memoryUsage.percentage).toBeGreaterThanOrEqual(0);
      expect(result.application.memoryUsage.percentage).toBeLessThanOrEqual(100);
    });

    it('should calculate uptime correctly', async () => {
      const result = await service.getCurrentHealthStatus();

      expect(result.application.uptime).toBeGreaterThan(0);
    });
  });

  describe('Error handling', () => {
    it('should handle repository errors gracefully', async () => {
      memberRepository.count = jest.fn().mockRejectedValue(new Error('Database error'));

      const result = await service.getCurrentHealthStatus();

      expect(result.business.totalMembers).toBe(0);
      expect(result.overall.status).toBe('CRITICAL');
    });

    it('should handle query builder errors', async () => {
      mockRepository.createQueryBuilder().getRawOne.mockRejectedValue(new Error('Query error'));

      const result = await service.getCurrentHealthStatus();

      expect(result.business.totalLoanAmount).toBe(0);
    });

    it('should handle consistency check errors', async () => {
      mockDataConsistencyService.runConsistencyChecks.mockRejectedValue(new Error('Consistency check failed'));

      const result = await service.getCurrentHealthStatus();

      expect(result.database.dataIntegrity.status).toBe('CRITICAL_ISSUES');
    });
  });

  describe('Health status thresholds', () => {
    it('should mark system as WARNING for moderate issues', async () => {
      mockDataConsistencyService.runConsistencyChecks.mockResolvedValue({
        overallStatus: 'ISSUES_FOUND',
        failedChecks: 0,
        warningChecks: 3,
        checks: [],
      });

      const result = await service.getCurrentHealthStatus();

      expect(result.overall.status).toBe('WARNING');
    });

    it('should mark system as CRITICAL for severe issues', async () => {
      mockDataSource.query.mockRejectedValue(new Error('Database down'));

      const result = await service.getCurrentHealthStatus();

      expect(result.overall.status).toBe('CRITICAL');
    });

    it('should provide appropriate recommendations based on status', async () => {
      mockDataConsistencyService.runConsistencyChecks.mockResolvedValue({
        overallStatus: 'CRITICAL_ISSUES',
        failedChecks: 5,
        warningChecks: 0,
        checks: [],
      });

      const result = await service.getCurrentHealthStatus();

      expect(result.overall.recommendations.length).toBeGreaterThan(0);
      expect(result.overall.recommendations.some(r => r.includes('immediate'))).toBe(true);
    });
  });
});
