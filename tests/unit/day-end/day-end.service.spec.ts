import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Repository, DataSource } from 'typeorm';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { DayEndService } from '../../../src/modules/admin/services/day-end.service';
import { BackupService } from '../../../src/modules/admin/services/backup.service';
import {
  DayEndProcess,
  DayEndStatus,
  DayEndProcessType,
} from '../../../src/modules/admin/entities/day-end-process.entity';
import {
  InterestPosting,
  InterestPostingType,
  InterestPostingStatus,
} from '../../../src/modules/admin/entities/interest-posting.entity';
import { LoanAccount } from '../../../src/modules/loan/entities/loan-account.entity';
import { Member } from '../../../src/modules/member/entities/member.entity';

describe('DayEndService', () => {
  let service: DayEndService;
  let dayEndProcessRepository: Repository<DayEndProcess>;
  let interestPostingRepository: Repository<InterestPosting>;
  let loanAccountRepository: Repository<LoanAccount>;
  let memberRepository: Repository<Member>;
  let dataSource: DataSource;
  let backupService: BackupService;

  const mockRepository = {
    create: jest.fn(),
    save: jest.fn(),
    find: jest.fn(),
    findOne: jest.fn(),
    findAndCount: jest.fn(),
    remove: jest.fn(),
  };

  const mockQueryRunner = {
    connect: jest.fn(),
    startTransaction: jest.fn(),
    commitTransaction: jest.fn(),
    rollbackTransaction: jest.fn(),
    release: jest.fn(),
    query: jest.fn(),
    manager: {
      save: jest.fn(),
      find: jest.fn(),
      // the check-and-insert in initiateDayEnd runs on a repository bound to the locked transaction (ES-429)
      getRepository: () => mockRepository,
    },
  };

  const mockDataSource = {
    createQueryRunner: jest.fn().mockReturnValue(mockQueryRunner),
    query: jest.fn(),
  };

  const mockBackupService = {
    createDatabaseBackup: jest.fn(),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        DayEndService,
        {
          provide: getRepositoryToken(DayEndProcess),
          useValue: mockRepository,
        },
        {
          provide: getRepositoryToken(InterestPosting),
          useValue: mockRepository,
        },
        {
          provide: getRepositoryToken(LoanAccount),
          useValue: mockRepository,
        },
        {
          provide: getRepositoryToken(Member),
          useValue: mockRepository,
        },
        {
          provide: DataSource,
          useValue: mockDataSource,
        },
        {
          provide: BackupService,
          useValue: mockBackupService,
        },
      ],
    }).compile();

    service = module.get<DayEndService>(DayEndService);
    dayEndProcessRepository = module.get<Repository<DayEndProcess>>(
      getRepositoryToken(DayEndProcess),
    );
    interestPostingRepository = module.get<Repository<InterestPosting>>(
      getRepositoryToken(InterestPosting),
    );
    loanAccountRepository = module.get<Repository<LoanAccount>>(
      getRepositoryToken(LoanAccount),
    );
    memberRepository = module.get<Repository<Member>>(
      getRepositoryToken(Member),
    );
    dataSource = module.get<DataSource>(DataSource);
    backupService = module.get<BackupService>(BackupService);
  });

  afterEach(() => {
    // reset (not just clear) so unused mockResolvedValueOnce values never leak into the next test
    jest.resetAllMocks();
    mockDataSource.createQueryRunner.mockReturnValue(mockQueryRunner);
  });

  describe('initiateDayEnd', () => {
    beforeEach(() => {
      mockDataSource.query.mockResolvedValueOnce([{ working_date: '2024-01-15' }]); // getworkingdate (pending date)
      mockQueryRunner.query
        .mockResolvedValueOnce([]) // advisory lock
        .mockResolvedValueOnce([{ next_id: 7 }]); // MAX(id)+1, read under the lock
    });

    it('should initiate day-end process successfully', async () => {
      const initiateDayEndDto = {
        processDate: '2024-01-15',
      };

      const mockProcess = {
        id: 1,
        processDate: new Date('2024-01-15'),
        status: DayEndStatus.IN_PROGRESS,
        startedAt: new Date(),
        processSteps: [],
        getDuration: () => 0,
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      mockRepository.findOne
        .mockResolvedValueOnce(null) // No existing completed process
        .mockResolvedValueOnce(null); // No ongoing process
      mockRepository.create.mockReturnValue(mockProcess);
      mockRepository.save.mockResolvedValue(mockProcess);

      // Mock the async execution
      jest.spyOn(service as any, 'executeDayEndProcess').mockResolvedValue(undefined);

      const result = await service.initiateDayEnd(initiateDayEndDto, 1);

      expect(mockRepository.findOne).toHaveBeenCalledTimes(2);
      expect(mockRepository.create).toHaveBeenCalled();
      expect(mockRepository.save).toHaveBeenCalled();
      expect(result.status).toBe(DayEndStatus.IN_PROGRESS);
    });

    it('should throw BadRequestException if day-end already completed', async () => {
      const initiateDayEndDto = {
        processDate: '2024-01-15',
        forceReprocess: false,
      };

      mockRepository.findOne.mockResolvedValue({
        id: 1,
        status: DayEndStatus.COMPLETED,
      });

      await expect(
        service.initiateDayEnd(initiateDayEndDto, 1),
      ).rejects.toThrow(BadRequestException);
    });

    it('should throw BadRequestException if another process is in progress', async () => {
      const initiateDayEndDto = {
        processDate: '2024-01-15',
      };

      mockRepository.findOne
        .mockResolvedValueOnce(null) // No existing completed process
        .mockResolvedValueOnce({ id: 2, status: DayEndStatus.IN_PROGRESS }); // Ongoing process

      await expect(
        service.initiateDayEnd(initiateDayEndDto, 1),
      ).rejects.toThrow(BadRequestException);
    });

    it('should allow reprocessing when forceReprocess is true', async () => {
      const initiateDayEndDto = {
        processDate: '2024-01-15',
        forceReprocess: true,
      };

      const mockProcess = {
        id: 1,
        processDate: new Date('2024-01-15'),
        status: DayEndStatus.IN_PROGRESS,
        startedAt: new Date(),
        processSteps: [],
        getDuration: () => 0,
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      mockRepository.findOne.mockResolvedValue(null); // No ongoing process
      mockRepository.create.mockReturnValue(mockProcess);
      mockRepository.save.mockResolvedValue(mockProcess);

      jest.spyOn(service as any, 'executeDayEndProcess').mockResolvedValue(undefined);

      const result = await service.initiateDayEnd(initiateDayEndDto, 1);

      expect(result.status).toBe(DayEndStatus.IN_PROGRESS);
    });
  });

  describe('getDayEndProcess', () => {
    it('should return day-end process by ID', async () => {
      const mockProcess = {
        id: 1,
        processDate: new Date('2024-01-15'),
        status: DayEndStatus.COMPLETED,
        startedAt: new Date(),
        completedAt: new Date(),
        processSteps: [],
        getDuration: () => 5000,
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      mockRepository.findOne.mockResolvedValue(mockProcess);

      const result = await service.getDayEndProcess(1);

      expect(mockRepository.findOne).toHaveBeenCalledWith({
        where: { id: 1 },
      });
      expect(result.id).toBe(1);
      expect(result.status).toBe(DayEndStatus.COMPLETED);
      expect(result.duration).toBe(5000);
    });

    it('should throw NotFoundException if process not found', async () => {
      mockRepository.findOne.mockResolvedValue(null);

      await expect(service.getDayEndProcess(999)).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe('getDayEndProcesses', () => {
    it('should return paginated day-end processes', async () => {
      const mockProcesses = [
        {
          id: 1,
          processDate: new Date('2024-01-15'),
          status: DayEndStatus.COMPLETED,
          getDuration: () => 5000,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
        {
          id: 2,
          processDate: new Date('2024-01-14'),
          status: DayEndStatus.COMPLETED,
          getDuration: () => 4500,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      ];

      mockRepository.findAndCount.mockResolvedValue([mockProcesses, 2]);

      const result = await service.getDayEndProcesses(1, 10);

      expect(mockRepository.findAndCount).toHaveBeenCalledWith({
        skip: 0,
        take: 10,
        order: { processDate: 'DESC' },
      });
      expect(result.processes).toHaveLength(2);
      expect(result.total).toBe(2);
      expect(result.totalPages).toBe(1);
    });
  });

  describe('getDayEndSummary', () => {
    it('should return day-end process summary', async () => {
      const mockProcess = {
        id: 1,
        processDate: new Date('2024-01-15'),
        status: DayEndStatus.COMPLETED,
        processSteps: [
          {
            type: DayEndProcessType.INTEREST_CALCULATION,
            status: DayEndStatus.COMPLETED,
          },
          {
            type: DayEndProcessType.BACKUP_CREATION,
            status: DayEndStatus.COMPLETED,
          },
          {
            type: DayEndProcessType.DATA_VALIDATION,
            status: DayEndStatus.FAILED,
          },
        ],
        processResults: {
          interestCalculations: {
            loansProcessed: 10,
            depositsProcessed: 5,
            totalInterestPosted: 1500.50,
          },
        },
        getDuration: () => 5000,
      };

      mockRepository.findOne.mockResolvedValue(mockProcess);

      const result = await service.getDayEndSummary(1);

      expect(result.totalSteps).toBe(3);
      expect(result.completedSteps).toBe(2);
      expect(result.failedSteps).toBe(1);
      expect(result.overallStatus).toBe(DayEndStatus.COMPLETED);
      expect(result.duration).toBe(5000);
      expect(result.interestCalculations).toEqual({
        loansProcessed: 10,
        depositsProcessed: 5,
        totalInterestPosted: 1500.50,
      });
    });
  });

  describe('getInterestCalculationResults', () => {
    it('should return interest calculation results', async () => {
      const mockProcess = {
        id: 1,
        processDate: new Date('2024-01-15'),
      };

      const mockInterestPostings = [
        {
          id: 1,
          accountId: 1,
          accountNumber: 'LOAN001',
          principalAmount: 100000,
          interestRate: 12.5,
          interestAmount: 34.25,
          calculationDate: new Date('2024-01-15'),
          status: InterestPostingStatus.POSTED,
          member: {
            firstName: 'John',
            lastName: 'Doe',
          },
        },
      ];

      mockRepository.findOne.mockResolvedValue(mockProcess);
      mockRepository.find.mockResolvedValue(mockInterestPostings);

      const result = await service.getInterestCalculationResults(1);

      expect(mockRepository.find).toHaveBeenCalledWith({
        where: {
          calculationDate: mockProcess.processDate,
        },
        relations: ['member'],
      });
      expect(result).toHaveLength(1);
      expect(result[0].accountNumber).toBe('LOAN001');
      expect(result[0].memberName).toBe('John Doe');
      expect(result[0].interestAmount).toBe(34.25);
    });
  });

  describe('private methods', () => {
    describe('calculateInterest', () => {
      it('does nothing and says so: interest is posted from its own screens, not by Day-End (ES-427)', async () => {
        const result = await (service as any).calculateInterest(new Date('2024-01-15'), mockQueryRunner);

        expect(result.skipped).toBe(true);
        expect(result.loansProcessed).toBe(0);
        expect(result.totalInterestPosted).toBe(0);
        expect(mockQueryRunner.manager.find).not.toHaveBeenCalled();
        expect(mockQueryRunner.manager.save).not.toHaveBeenCalled();
      });

      it('new Day-End runs no longer include an interest step', () => {
        const steps = (service as any).getProcessSteps();
        expect(steps.map((x: any) => x.type)).not.toContain('interest_calculation');
      });
    });

    describe('createBackup', () => {
      it('should create database backup', async () => {
        const processDate = new Date('2024-01-15');
        const mockBackupResult = {
          size: 1024000,
          path: '/backups/dayend_2024-01-15.sql',
        };

        mockBackupService.createDatabaseBackup.mockResolvedValue(mockBackupResult);

        const result = await (service as any).createBackup(processDate);

        expect(mockBackupService.createDatabaseBackup).toHaveBeenCalledWith(
          'dayend_2024-01-15',
        );
        expect(result.backupSize).toBe(1024000);
        expect(result.backupPath).toBe('/backups/dayend_2024-01-15.sql');
      });
    });

    describe('validateData', () => {
      it('should validate loan data (deposit/FD validation removed — no member-facing FD product exists)', async () => {
        const processDate = new Date('2024-01-15');

        const mockLoans = [
          { accountNumber: 'LOAN001', outstandingBalance: 100000 },
          { accountNumber: 'LOAN002', outstandingBalance: -1000 }, // Invalid
        ];

        mockQueryRunner.manager.find.mockResolvedValueOnce(mockLoans);

        const result = await (service as any).validateData(
          processDate,
          mockQueryRunner,
        );

        expect(result.totalChecks).toBe(2);
        expect(result.passedChecks).toBe(1);
        expect(result.failedChecks).toBe(1);
        expect(result.warnings).toHaveLength(1);
        expect(result.warnings[0]).toContain('negative outstanding balance');
      });
    });
  });

  describe('extra: working date, id allocation, bootstrap', () => {
    const proc = () => ({ id: 7, processDate: new Date('2024-01-15'), status: DayEndStatus.IN_PROGRESS, processSteps: [], getDuration: () => 0 });

    it('the day closed is the pending working date from getworkingdate, not the date the client sent', async () => {
      mockDataSource.query.mockResolvedValueOnce([{ working_date: '2024-01-15' }]);
      mockQueryRunner.query.mockResolvedValueOnce([]).mockResolvedValueOnce([{ next_id: 7 }]);
      mockRepository.findOne.mockResolvedValue(null);
      mockRepository.create.mockImplementation((x: any) => x);
      mockRepository.save.mockImplementation(async (x: any) => ({ ...proc(), ...x, getDuration: () => 0 }));
      jest.spyOn(service as any, 'executeDayEndProcess').mockResolvedValue(undefined);
      await service.initiateDayEnd({ processDate: '2030-12-31' } as any, 1);
      const created = mockRepository.create.mock.calls[0][0];
      expect(created.processDate.getFullYear()).toBe(2024);
      expect(created.id).toBe(7);
      expect(created.initiatedBy).toBe(1);
    });

    it('allocating the process id and the in-progress check are done under a lock (two clicks cannot both start)', async () => {
      mockDataSource.query.mockResolvedValueOnce([{ working_date: '2024-01-15' }]);
      mockQueryRunner.query.mockResolvedValueOnce([]).mockResolvedValueOnce([{ next_id: 7 }]);
      mockRepository.findOne.mockResolvedValue(null);
      mockRepository.create.mockImplementation((x: any) => x);
      mockRepository.save.mockImplementation(async (x: any) => ({ ...proc(), ...x }));
      jest.spyOn(service as any, 'executeDayEndProcess').mockResolvedValue(undefined);
      await service.initiateDayEnd({ processDate: '2024-01-15' } as any, 1);
      const sql = mockQueryRunner.query.mock.calls.map((c: any) => c[0]);
      // the lock comes first, then the id is read, then the transaction is committed: all on the same connection
      expect(sql[0]).toMatch(/pg_advisory_xact_lock/i);
      expect(sql[1]).toContain('MAX(id)');
      expect(mockQueryRunner.startTransaction).toHaveBeenCalled();
      expect(mockQueryRunner.commitTransaction).toHaveBeenCalledTimes(1);
      expect(mockQueryRunner.query.mock.invocationCallOrder[0]).toBeLessThan(mockQueryRunner.commitTransaction.mock.invocationCallOrder[0]);
    });

    it('initializeWorkingDate refuses when a working date already exists', async () => {
      mockDataSource.query.mockResolvedValueOnce([{ '?column?': 1 }]);
      await expect(service.initializeWorkingDate('2026-04-01')).rejects.toThrow(BadRequestException);
    });

    it('initializeWorkingDate rejects a malformed date before touching the table', async () => {
      mockDataSource.query.mockResolvedValueOnce([]);
      for (const bad of ['01-04-2026', '2026-4-1', "2026-04-01'; DROP", '']) {
        mockDataSource.query.mockResolvedValueOnce([]);
        await expect(service.initializeWorkingDate(bad)).rejects.toThrow(BadRequestException);
      }
      expect(mockDataSource.query.mock.calls.some((c: any) => /INSERT/.test(c[0]))).toBe(false);
    });

    it('initializeWorkingDate inserts the date as a bound parameter', async () => {
      mockDataSource.query.mockResolvedValueOnce([]).mockResolvedValueOnce([]);
      await service.initializeWorkingDate('2026-04-01');
      const ins = mockDataSource.query.mock.calls.find((c: any) => /INSERT/.test(c[0]));
      expect(ins[1]).toEqual(['2026-04-01']);
    });

    it('summary counts completed and failed steps and tolerates a process with no steps', async () => {
      mockRepository.findOne.mockResolvedValue({ id: 1, processDate: new Date(), status: DayEndStatus.FAILED, processSteps: undefined, getDuration: () => 0 });
      const r = await service.getDayEndSummary(1);
      expect(r).toMatchObject({ totalSteps: 0, completedSteps: 0, failedSteps: 0 });
    });

    it('paging: page 3 of size 5 skips 10 rows and totalPages rounds up', async () => {
      mockRepository.findAndCount.mockResolvedValue([[], 11]);
      const r = await service.getDayEndProcesses(3, 5);
      expect(mockRepository.findAndCount).toHaveBeenCalledWith(expect.objectContaining({ skip: 10, take: 5 }));
      expect(r.totalPages).toBe(3);
    });

    it('interest for a loan with a zero balance is skipped', async () => {
      mockQueryRunner.manager.find.mockResolvedValueOnce([{ id: 1, outstandingBalance: 0, interestRate: 12, member: { id: 1 } }]);
      const r = await (service as any).calculateInterest(new Date('2024-01-15'), mockQueryRunner);
      expect(r.loansProcessed).toBe(0);
    });
  });
});
