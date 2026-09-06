import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Repository, DataSource } from 'typeorm';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { DayEndService } from './day-end.service';
import { BackupService } from './backup.service';
import { LogRetentionService } from '../../../common/logging/log-retention.service';
import {
  DayEndProcess,
  DayEndStatus,
  DayEndProcessType,
} from '../entities/day-end-process.entity';

describe('DayEndService', () => {
  let service: DayEndService;
  let dayEndProcessRepository: Repository<DayEndProcess>;
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
    manager: {
      save: jest.fn(),
      find: jest.fn(),
    },
    query: jest.fn().mockResolvedValue([]),
  };

  const mockDataSource = {
    createQueryRunner: jest.fn().mockReturnValue(mockQueryRunner),
  };

  const mockBackupService = {
    createDatabaseBackup: jest.fn(),
  };

  const mockLogRetentionService = {
    enforceRetention: jest.fn().mockResolvedValue({ movedCount: 0, deletedCount: 0, freedBytes: 0 }),
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
          provide: DataSource,
          useValue: mockDataSource,
        },
        {
          provide: BackupService,
          useValue: mockBackupService,
        },
        {
          provide: LogRetentionService,
          useValue: mockLogRetentionService,
        },
      ],
    }).compile();

    service = module.get<DayEndService>(DayEndService);
    dayEndProcessRepository = module.get<Repository<DayEndProcess>>(
      getRepositoryToken(DayEndProcess),
    );
    dataSource = module.get<DataSource>(DataSource);
    backupService = module.get<BackupService>(BackupService);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('initiateDayEnd', () => {
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
            type: DayEndProcessType.BACKUP_CREATION,
            status: DayEndStatus.COMPLETED,
          },
          {
            type: DayEndProcessType.DATA_VALIDATION,
            status: DayEndStatus.FAILED,
          },
        ],
        processResults: {},
        getDuration: () => 5000,
      };

      mockRepository.findOne.mockResolvedValue(mockProcess);

      const result = await service.getDayEndSummary(1);

      expect(result.totalSteps).toBe(2);
      expect(result.completedSteps).toBe(1);
      expect(result.failedSteps).toBe(1);
      expect(result.overallStatus).toBe(DayEndStatus.COMPLETED);
      expect(result.duration).toBe(5000);
    });
  });

  describe('private methods', () => {
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
      it('should validate loan and deposit data', async () => {
        const processDate = new Date('2024-01-15');
        
        const mockLoans = [
          { accountNumber: 'LOAN001', outstandingBalance: 100000 },
          { accountNumber: 'LOAN002', outstandingBalance: -1000 }, // Invalid
        ];

        const mockDeposits = [
          { accountNumber: 'FD001', principalAmount: 50000 },
          { accountNumber: 'FD002', principalAmount: 0 }, // Invalid
        ];

        mockQueryRunner.manager.find
          .mockResolvedValueOnce(mockLoans)
          .mockResolvedValueOnce(mockDeposits);

        const result = await (service as any).validateData(
          processDate,
          mockQueryRunner,
        );

        expect(result.totalChecks).toBe(4);
        expect(result.passedChecks).toBe(2);
        expect(result.failedChecks).toBe(2);
        expect(result.warnings).toHaveLength(2);
        expect(result.warnings[0]).toContain('negative outstanding balance');
        expect(result.warnings[1]).toContain('invalid principal amount');
      });
    });
  });
});
