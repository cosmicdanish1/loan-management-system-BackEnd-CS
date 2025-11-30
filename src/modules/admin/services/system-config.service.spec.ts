import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ConflictException, NotFoundException, BadRequestException } from '@nestjs/common';
import { SystemConfigService } from './system-config.service';
import {
  SystemConfig,
  ConfigCategory,
  ConfigDataType,
} from '../entities/system-config.entity';
import {
  InterestRate,
  InterestRateType,
  InterestCalculationMethod,
} from '../entities/interest-rate.entity';
import {
  DepositSlab,
  DepositSlabType,
} from '../entities/deposit-slab.entity';

describe('SystemConfigService', () => {
  let service: SystemConfigService;
  let systemConfigRepository: Repository<SystemConfig>;
  let interestRateRepository: Repository<InterestRate>;
  let depositSlabRepository: Repository<DepositSlab>;

  const mockSystemConfigRepository = {
    create: jest.fn(),
    save: jest.fn(),
    find: jest.fn(),
    findOne: jest.fn(),
    remove: jest.fn(),
    count: jest.fn(),
  };

  const mockInterestRateRepository = {
    create: jest.fn(),
    save: jest.fn(),
    find: jest.fn(),
    findOne: jest.fn(),
    remove: jest.fn(),
  };

  const mockDepositSlabRepository = {
    create: jest.fn(),
    save: jest.fn(),
    find: jest.fn(),
    findOne: jest.fn(),
    remove: jest.fn(),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SystemConfigService,
        {
          provide: getRepositoryToken(SystemConfig),
          useValue: mockSystemConfigRepository,
        },
        {
          provide: getRepositoryToken(InterestRate),
          useValue: mockInterestRateRepository,
        },
        {
          provide: getRepositoryToken(DepositSlab),
          useValue: mockDepositSlabRepository,
        },
      ],
    }).compile();

    service = module.get<SystemConfigService>(SystemConfigService);
    systemConfigRepository = module.get<Repository<SystemConfig>>(
      getRepositoryToken(SystemConfig),
    );
    interestRateRepository = module.get<Repository<InterestRate>>(
      getRepositoryToken(InterestRate),
    );
    depositSlabRepository = module.get<Repository<DepositSlab>>(
      getRepositoryToken(DepositSlab),
    );
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('createSystemConfig', () => {
    it('should create a new system configuration', async () => {
      const createDto = {
        key: 'test_config',
        name: 'Test Config',
        value: '10.5',
        dataType: ConfigDataType.PERCENTAGE,
        category: ConfigCategory.INTEREST_RATES,
      };

      const mockConfig = {
        id: 1,
        ...createDto,
        getTypedValue: () => 10.5,
      };

      mockSystemConfigRepository.findOne.mockResolvedValue(null);
      mockSystemConfigRepository.create.mockReturnValue(mockConfig);
      mockSystemConfigRepository.save.mockResolvedValue(mockConfig);

      const result = await service.createSystemConfig(createDto);

      expect(mockSystemConfigRepository.findOne).toHaveBeenCalledWith({
        where: { key: createDto.key },
      });
      expect(mockSystemConfigRepository.create).toHaveBeenCalledWith(createDto);
      expect(mockSystemConfigRepository.save).toHaveBeenCalledWith(mockConfig);
      expect(result.key).toBe(createDto.key);
      expect(result.typedValue).toBe(10.5);
    });

    it('should throw ConflictException if key already exists', async () => {
      const createDto = {
        key: 'existing_config',
        name: 'Existing Config',
        value: '10.5',
        dataType: ConfigDataType.PERCENTAGE,
        category: ConfigCategory.INTEREST_RATES,
      };

      mockSystemConfigRepository.findOne.mockResolvedValue({ id: 1 });

      await expect(service.createSystemConfig(createDto)).rejects.toThrow(
        ConflictException,
      );
    });

    it('should throw BadRequestException for invalid number value', async () => {
      const createDto = {
        key: 'test_config',
        name: 'Test Config',
        value: 'invalid_number',
        dataType: ConfigDataType.NUMBER,
        category: ConfigCategory.SYSTEM_SETTINGS,
      };

      mockSystemConfigRepository.findOne.mockResolvedValue(null);

      await expect(service.createSystemConfig(createDto)).rejects.toThrow(
        BadRequestException,
      );
    });
  });

  describe('findSystemConfigByKey', () => {
    it('should return configuration by key', async () => {
      const mockConfig = {
        id: 1,
        key: 'test_config',
        name: 'Test Config',
        value: '10.5',
        dataType: ConfigDataType.PERCENTAGE,
        getTypedValue: () => 10.5,
      };

      mockSystemConfigRepository.findOne.mockResolvedValue(mockConfig);

      const result = await service.findSystemConfigByKey('test_config');

      expect(mockSystemConfigRepository.findOne).toHaveBeenCalledWith({
        where: { key: 'test_config' },
      });
      expect(result.key).toBe('test_config');
      expect(result.typedValue).toBe(10.5);
    });

    it('should throw NotFoundException if config not found', async () => {
      mockSystemConfigRepository.findOne.mockResolvedValue(null);

      await expect(service.findSystemConfigByKey('nonexistent')).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe('updateSystemConfig', () => {
    it('should update system configuration', async () => {
      const mockConfig = {
        id: 1,
        key: 'test_config',
        name: 'Test Config',
        value: '10.5',
        dataType: ConfigDataType.PERCENTAGE,
        isReadonly: false,
        getTypedValue: () => 15.0,
      };

      const updateDto = {
        value: '15.0',
      };

      mockSystemConfigRepository.findOne.mockResolvedValue(mockConfig);
      mockSystemConfigRepository.save.mockResolvedValue({
        ...mockConfig,
        ...updateDto,
      });

      const result = await service.updateSystemConfig(1, updateDto);

      expect(mockSystemConfigRepository.findOne).toHaveBeenCalledWith({
        where: { id: 1 },
      });
      expect(mockSystemConfigRepository.save).toHaveBeenCalled();
      expect(result.value).toBe('15.0');
    });

    it('should throw BadRequestException for readonly config', async () => {
      const mockConfig = {
        id: 1,
        isReadonly: true,
      };

      mockSystemConfigRepository.findOne.mockResolvedValue(mockConfig);

      await expect(
        service.updateSystemConfig(1, { value: '15.0' }),
      ).rejects.toThrow(BadRequestException);
    });
  });

  describe('createInterestRate', () => {
    it('should create a new interest rate', async () => {
      const createDto = {
        name: 'Personal Loan Rate',
        type: InterestRateType.LOAN,
        rate: 12.5,
        calculationMethod: InterestCalculationMethod.REDUCING_BALANCE,
        effectiveFrom: '2024-01-01',
      };

      const mockRate = {
        id: 1,
        ...createDto,
        effectiveFrom: new Date('2024-01-01'),
      };

      mockInterestRateRepository.create.mockReturnValue(mockRate);
      mockInterestRateRepository.save.mockResolvedValue(mockRate);

      const result = await service.createInterestRate(createDto);

      expect(mockInterestRateRepository.create).toHaveBeenCalledWith({
        ...createDto,
        effectiveFrom: new Date('2024-01-01'),
        effectiveTo: null,
      });
      expect(mockInterestRateRepository.save).toHaveBeenCalledWith(mockRate);
      expect(result.name).toBe(createDto.name);
      expect(result.rate).toBe(createDto.rate);
    });
  });

  describe('getApplicableInterestRate', () => {
    it('should return applicable interest rate', async () => {
      const mockRates = [
        {
          id: 1,
          type: InterestRateType.LOAN,
          rate: 12.5,
          isActive: true,
          isApplicable: jest.fn().mockReturnValue(true),
        },
        {
          id: 2,
          type: InterestRateType.LOAN,
          rate: 10.0,
          isActive: true,
          isApplicable: jest.fn().mockReturnValue(false),
        },
      ];

      mockInterestRateRepository.find.mockResolvedValue(mockRates);

      const result = await service.getApplicableInterestRate(
        InterestRateType.LOAN,
        100000,
        365,
      );

      expect(mockInterestRateRepository.find).toHaveBeenCalledWith({
        where: { type: InterestRateType.LOAN, isActive: true },
        order: { effectiveFrom: 'DESC' },
      });
      expect(result).toBe(mockRates[0]);
      expect(mockRates[0].isApplicable).toHaveBeenCalledWith(100000, 365, expect.any(Date));
    });

    it('should return null if no applicable rate found', async () => {
      const mockRates = [
        {
          id: 1,
          isApplicable: jest.fn().mockReturnValue(false),
        },
      ];

      mockInterestRateRepository.find.mockResolvedValue(mockRates);

      const result = await service.getApplicableInterestRate(
        InterestRateType.LOAN,
        100000,
        365,
      );

      expect(result).toBeNull();
    });
  });

  describe('createDepositSlab', () => {
    it('should create a new deposit slab', async () => {
      const createDto = {
        name: 'FD Slab 1-5 Lakhs',
        type: DepositSlabType.FIXED_DEPOSIT,
        minAmount: 100000,
        maxAmount: 500000,
        minTenure: 365,
        maxTenure: 1825,
        interestRate: 8.5,
        effectiveFrom: '2024-01-01',
      };

      const mockSlab = {
        id: 1,
        ...createDto,
        effectiveFrom: new Date('2024-01-01'),
      };

      mockDepositSlabRepository.create.mockReturnValue(mockSlab);
      mockDepositSlabRepository.save.mockResolvedValue(mockSlab);

      const result = await service.createDepositSlab(createDto);

      expect(mockDepositSlabRepository.create).toHaveBeenCalledWith({
        ...createDto,
        effectiveFrom: new Date('2024-01-01'),
        effectiveTo: null,
      });
      expect(mockDepositSlabRepository.save).toHaveBeenCalledWith(mockSlab);
      expect(result.name).toBe(createDto.name);
      expect(result.interestRate).toBe(createDto.interestRate);
    });
  });

  describe('getApplicableDepositSlab', () => {
    it('should return applicable deposit slab', async () => {
      const mockSlabs = [
        {
          id: 1,
          type: DepositSlabType.FIXED_DEPOSIT,
          interestRate: 8.5,
          isActive: true,
          isApplicable: jest.fn().mockReturnValue(true),
        },
        {
          id: 2,
          type: DepositSlabType.FIXED_DEPOSIT,
          interestRate: 7.5,
          isActive: true,
          isApplicable: jest.fn().mockReturnValue(false),
        },
      ];

      mockDepositSlabRepository.find.mockResolvedValue(mockSlabs);

      const result = await service.getApplicableDepositSlab(
        DepositSlabType.FIXED_DEPOSIT,
        200000,
        730,
      );

      expect(mockDepositSlabRepository.find).toHaveBeenCalledWith({
        where: { type: DepositSlabType.FIXED_DEPOSIT, isActive: true },
        order: { minAmount: 'ASC' },
      });
      expect(result).toBe(mockSlabs[0]);
      expect(mockSlabs[0].isApplicable).toHaveBeenCalledWith(200000, 730, expect.any(Date));
    });
  });

  describe('initializeDefaultConfigs', () => {
    it('should initialize default configurations', async () => {
      mockSystemConfigRepository.findOne.mockResolvedValue(null);
      mockSystemConfigRepository.create.mockReturnValue({});
      mockSystemConfigRepository.save.mockResolvedValue({});

      await service.initializeDefaultConfigs();

      expect(mockSystemConfigRepository.findOne).toHaveBeenCalledTimes(6); // 6 default configs
      expect(mockSystemConfigRepository.create).toHaveBeenCalledTimes(6);
      expect(mockSystemConfigRepository.save).toHaveBeenCalledTimes(6);
    });

    it('should not create configs that already exist', async () => {
      mockSystemConfigRepository.findOne.mockResolvedValue({ id: 1 }); // Existing config

      await service.initializeDefaultConfigs();

      expect(mockSystemConfigRepository.findOne).toHaveBeenCalledTimes(6);
      expect(mockSystemConfigRepository.create).not.toHaveBeenCalled();
      expect(mockSystemConfigRepository.save).not.toHaveBeenCalled();
    });
  });
});
