import {
  Injectable,
  NotFoundException,
  ConflictException,
  BadRequestException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, FindManyOptions, Like } from 'typeorm';
import {
  SystemConfig,
  ConfigCategory,
  ConfigDataType,
} from '../entities/system-config.entity';
import {
  InterestRate,
  InterestRateType,
} from '../entities/interest-rate.entity';
import {
  DepositSlab,
  DepositSlabType,
} from '../entities/deposit-slab.entity';
import {
  CreateSystemConfigDto,
  UpdateSystemConfigDto,
  SystemConfigResponseDto,
  CreateInterestRateDto,
  UpdateInterestRateDto,
  InterestRateResponseDto,
  CreateDepositSlabDto,
  UpdateDepositSlabDto,
  DepositSlabResponseDto,
} from '../dto';

@Injectable()
export class SystemConfigService {
  constructor(
    @InjectRepository(SystemConfig)
    private systemConfigRepository: Repository<SystemConfig>,
    @InjectRepository(InterestRate)
    private interestRateRepository: Repository<InterestRate>,
    @InjectRepository(DepositSlab)
    private depositSlabRepository: Repository<DepositSlab>,
  ) { }

  // System Configuration Methods
  async createSystemConfig(createDto: CreateSystemConfigDto): Promise<SystemConfigResponseDto> {
    // Check if key already exists
    const existingConfig = await this.systemConfigRepository.findOne({
      where: { key: createDto.key },
    });

    if (existingConfig) {
      throw new ConflictException('Configuration key already exists');
    }

    // Validate the value based on data type
    this.validateConfigValue(createDto.value, createDto.dataType, createDto.validationRules);

    const config = this.systemConfigRepository.create(createDto);
    const savedConfig = await this.systemConfigRepository.save(config);

    return this.mapConfigToResponseDto(savedConfig);
  }

  async findAllSystemConfigs(
    category?: ConfigCategory,
    isActive?: boolean,
  ): Promise<SystemConfigResponseDto[]> {
    const options: FindManyOptions<SystemConfig> = {
      order: { category: 'ASC', key: 'ASC' },
    };

    const where: any = {};
    if (category) where.category = category;
    if (isActive !== undefined) where.isActive = isActive;

    if (Object.keys(where).length > 0) {
      options.where = where;
    }

    const configs = await this.systemConfigRepository.find(options);
    return configs.map(config => this.mapConfigToResponseDto(config));
  }

  async findSystemConfigByKey(key: string): Promise<SystemConfigResponseDto> {
    const config = await this.systemConfigRepository.findOne({
      where: { key },
    });

    if (!config) {
      throw new NotFoundException('Configuration not found');
    }

    return this.mapConfigToResponseDto(config);
  }

  async updateSystemConfig(
    id: number,
    updateDto: UpdateSystemConfigDto,
  ): Promise<SystemConfigResponseDto> {
    const config = await this.systemConfigRepository.findOne({
      where: { id },
    });

    if (!config) {
      throw new NotFoundException('Configuration not found');
    }

    if (config.isReadonly) {
      throw new BadRequestException('Cannot update read-only configuration');
    }

    // Validate the value if being updated
    if (updateDto.value !== undefined) {
      const dataType = updateDto.dataType || config.dataType;
      const validationRules = updateDto.validationRules || config.validationRules;
      this.validateConfigValue(updateDto.value, dataType, validationRules);
    }

    Object.assign(config, updateDto);
    const updatedConfig = await this.systemConfigRepository.save(config);

    return this.mapConfigToResponseDto(updatedConfig);
  }

  async deleteSystemConfig(id: number): Promise<{ message: string }> {
    const config = await this.systemConfigRepository.findOne({
      where: { id },
    });

    if (!config) {
      throw new NotFoundException('Configuration not found');
    }

    if (config.isReadonly) {
      throw new BadRequestException('Cannot delete read-only configuration');
    }

    await this.systemConfigRepository.remove(config);
    return { message: 'Configuration deleted successfully' };
  }

  async getConfigValue(key: string): Promise<any> {
    const config = await this.systemConfigRepository.findOne({
      where: { key, isActive: true },
    });

    if (!config) {
      throw new NotFoundException(`Configuration '${key}' not found`);
    }

    return config.getTypedValue();
  }

  async setConfigValue(key: string, value: any): Promise<SystemConfigResponseDto> {
    const config = await this.systemConfigRepository.findOne({
      where: { key },
    });

    if (!config) {
      throw new NotFoundException(`Configuration '${key}' not found`);
    }

    if (config.isReadonly) {
      throw new BadRequestException('Cannot update read-only configuration');
    }

    config.setTypedValue(value);
    const updatedConfig = await this.systemConfigRepository.save(config);

    return this.mapConfigToResponseDto(updatedConfig);
  }

  async getBusinessRules(): Promise<any> {
    const rules = await this.systemConfigRepository.find({
      where: [
        { key: Like('RULE_%'), isActive: true },
        { key: Like('SYS_%'), isActive: true },
      ],
    });

    const result: any = {};
    rules.forEach(rule => {
      result[rule.key] = rule.getTypedValue();
    });
    return result;
  }

  async bulkUpdateBusinessRules(rules: Record<string, any>): Promise<void> {
    for (const [key, value] of Object.entries(rules)) {
      let config = await this.systemConfigRepository.findOne({ where: { key } });

      if (!config) {
        const dataType =
          typeof value === 'boolean'
            ? ConfigDataType.BOOLEAN
            : value !== '' && !isNaN(Number(value))
              ? ConfigDataType.NUMBER
              : ConfigDataType.STRING;
        config = this.systemConfigRepository.create({
          key,
          name: key.replace(/_/g, ' ').toLowerCase(),
          value: String(value),
          dataType,
          category: ConfigCategory.BUSINESS_RULES,
          isActive: true,
          isReadonly: false,
        });
        await this.systemConfigRepository.save(config);
      } else if (!config.isReadonly) {
        config.setTypedValue(value);
        await this.systemConfigRepository.save(config);
      }
    }
  }

  // Interest Rate Methods
  async createInterestRate(createDto: CreateInterestRateDto): Promise<InterestRateResponseDto> {
    const interestRate = this.interestRateRepository.create({
      ...createDto,
      effectiveFrom: new Date(createDto.effectiveFrom),
      effectiveTo: createDto.effectiveTo ? new Date(createDto.effectiveTo) : null,
    });

    const savedRate = await this.interestRateRepository.save(interestRate);
    return savedRate;
  }

  async findAllInterestRates(
    type?: InterestRateType,
    isActive?: boolean,
  ): Promise<InterestRateResponseDto[]> {
    const options: FindManyOptions<InterestRate> = {
      order: { type: 'ASC', effectiveFrom: 'DESC' },
    };

    const where: any = {};
    if (type) where.type = type;
    if (isActive !== undefined) where.isActive = isActive;

    if (Object.keys(where).length > 0) {
      options.where = where;
    }

    return this.interestRateRepository.find(options);
  }

  async findInterestRateById(id: number): Promise<InterestRateResponseDto> {
    const rate = await this.interestRateRepository.findOne({
      where: { id },
    });

    if (!rate) {
      throw new NotFoundException('Interest rate not found');
    }

    return rate;
  }

  async updateInterestRate(
    id: number,
    updateDto: UpdateInterestRateDto,
  ): Promise<InterestRateResponseDto> {
    const rate = await this.interestRateRepository.findOne({
      where: { id },
    });

    if (!rate) {
      throw new NotFoundException('Interest rate not found');
    }

    const updateData: any = { ...updateDto };
    if (updateDto.effectiveFrom) {
      updateData.effectiveFrom = new Date(updateDto.effectiveFrom);
    }
    if (updateDto.effectiveTo) {
      updateData.effectiveTo = new Date(updateDto.effectiveTo);
    }

    Object.assign(rate, updateData);
    return this.interestRateRepository.save(rate);
  }

  async deleteInterestRate(id: number): Promise<{ message: string }> {
    const rate = await this.interestRateRepository.findOne({
      where: { id },
    });

    if (!rate) {
      throw new NotFoundException('Interest rate not found');
    }

    await this.interestRateRepository.remove(rate);
    return { message: 'Interest rate deleted successfully' };
  }

  async getApplicableInterestRate(
    type: InterestRateType,
    amount: number,
    tenure?: number,
    date: Date = new Date(),
  ): Promise<InterestRateResponseDto | null> {
    const rates = await this.interestRateRepository.find({
      where: { type, isActive: true },
      order: { effectiveFrom: 'DESC' },
    });

    for (const rate of rates) {
      if (rate.isApplicable(amount, tenure, date)) {
        return rate;
      }
    }

    return null;
  }

  // Deposit Slab Methods
  async createDepositSlab(createDto: CreateDepositSlabDto): Promise<DepositSlabResponseDto> {
    const depositSlab = this.depositSlabRepository.create({
      ...createDto,
      effectiveFrom: new Date(createDto.effectiveFrom),
      effectiveTo: createDto.effectiveTo ? new Date(createDto.effectiveTo) : null,
    });

    const savedSlab = await this.depositSlabRepository.save(depositSlab);
    return savedSlab;
  }

  async findAllDepositSlabs(
    type?: DepositSlabType,
    isActive?: boolean,
  ): Promise<DepositSlabResponseDto[]> {
    const options: FindManyOptions<DepositSlab> = {
      order: { type: 'ASC', minAmount: 'ASC' },
    };

    const where: any = {};
    if (type) where.type = type;
    if (isActive !== undefined) where.isActive = isActive;

    if (Object.keys(where).length > 0) {
      options.where = where;
    }

    return this.depositSlabRepository.find(options);
  }

  async findDepositSlabById(id: number): Promise<DepositSlabResponseDto> {
    const slab = await this.depositSlabRepository.findOne({
      where: { id },
    });

    if (!slab) {
      throw new NotFoundException('Deposit slab not found');
    }

    return slab;
  }

  async updateDepositSlab(
    id: number,
    updateDto: UpdateDepositSlabDto,
  ): Promise<DepositSlabResponseDto> {
    const slab = await this.depositSlabRepository.findOne({
      where: { id },
    });

    if (!slab) {
      throw new NotFoundException('Deposit slab not found');
    }

    const updateData: any = { ...updateDto };
    if (updateDto.effectiveFrom) {
      updateData.effectiveFrom = new Date(updateDto.effectiveFrom);
    }
    if (updateDto.effectiveTo) {
      updateData.effectiveTo = new Date(updateDto.effectiveTo);
    }

    Object.assign(slab, updateData);
    return this.depositSlabRepository.save(slab);
  }

  async deleteDepositSlab(id: number): Promise<{ message: string }> {
    const slab = await this.depositSlabRepository.findOne({
      where: { id },
    });

    if (!slab) {
      throw new NotFoundException('Deposit slab not found');
    }

    await this.depositSlabRepository.remove(slab);
    return { message: 'Deposit slab deleted successfully' };
  }

  // Bulk replace-all slabs for a given type (used by the Deposit/Loan Slab configuration screen)
  async bulkSaveDepositSlabs(
    type: DepositSlabType,
    rows: CreateDepositSlabDto[],
  ): Promise<{ saved: number; type: string }> {
    // Delete all existing slabs for this type, then insert fresh
    await this.depositSlabRepository.delete({ type });
    if (rows.length > 0) {
      const entities = rows.map(r =>
        this.depositSlabRepository.create({
          ...r,
          type,
          effectiveFrom: new Date(r.effectiveFrom),
          effectiveTo: r.effectiveTo ? new Date(r.effectiveTo) : null,
        }),
      );
      await this.depositSlabRepository.save(entities);
    }
    return { saved: rows.length, type };
  }

  async getApplicableDepositSlab(
    type: DepositSlabType,
    amount: number,
    tenure: number,
    date: Date = new Date(),
  ): Promise<DepositSlabResponseDto | null> {
    const slabs = await this.depositSlabRepository.find({
      where: { type, isActive: true },
      order: { minAmount: 'ASC' },
    });

    for (const slab of slabs) {
      if (slab.isApplicable(amount, tenure, date)) {
        return slab;
      }
    }

    return null;
  }

  // Utility Methods
  async initializeDefaultConfigs(): Promise<void> {
    const defaultConfigs = [
      {
        key: 'default_loan_interest_rate',
        name: 'Default Loan Interest Rate',
        description: 'Default interest rate for loans when no specific rate is configured',
        value: '12.0',
        dataType: ConfigDataType.PERCENTAGE,
        category: ConfigCategory.INTEREST_RATES,
        unit: '%',
      },
      {
        key: 'default_fd_interest_rate',
        name: 'Default FD Interest Rate',
        description: 'Default interest rate for fixed deposits',
        value: '8.0',
        dataType: ConfigDataType.PERCENTAGE,
        category: ConfigCategory.INTEREST_RATES,
        unit: '%',
      },
      {
        key: 'min_loan_amount',
        name: 'Minimum Loan Amount',
        description: 'Minimum amount that can be sanctioned as loan',
        value: '5000',
        dataType: ConfigDataType.NUMBER,
        category: ConfigCategory.LOAN_SETTINGS,
        unit: 'INR',
      },
      {
        key: 'max_loan_amount',
        name: 'Maximum Loan Amount',
        description: 'Maximum amount that can be sanctioned as loan',
        value: '1000000',
        dataType: ConfigDataType.NUMBER,
        category: ConfigCategory.LOAN_SETTINGS,
        unit: 'INR',
      },
      {
        key: 'min_fd_amount',
        name: 'Minimum FD Amount',
        description: 'Minimum amount for fixed deposit',
        value: '1000',
        dataType: ConfigDataType.NUMBER,
        category: ConfigCategory.DEPOSIT_SLABS,
        unit: 'INR',
      },
      {
        key: 'penalty_rate_premature_withdrawal',
        name: 'Penalty Rate for Premature Withdrawal',
        description: 'Penalty rate applied on premature withdrawal of deposits',
        value: '1.0',
        dataType: ConfigDataType.PERCENTAGE,
        category: ConfigCategory.DEPOSIT_SLABS,
        unit: '%',
      },
      // Fund Management Rules
      {
        key: 'RULE_FUND_INT_RATE',
        name: 'Annual Fund Interest Rate',
        description: 'Fixed interest rate on current balance annually',
        value: '7.0',
        dataType: ConfigDataType.PERCENTAGE,
        category: ConfigCategory.BUSINESS_RULES,
        unit: '%',
      },
      {
        key: 'RULE_DIVIDEND_PCT',
        name: 'Dividend Profit Percentage',
        description: 'Dividend profit percentage on current stakes',
        value: '0.0',
        dataType: ConfigDataType.PERCENTAGE,
        category: ConfigCategory.BUSINESS_RULES,
        unit: '%',
      },
      {
        key: 'RULE_GRP_INSURANCE_AMT',
        name: 'Group Insurance Amount',
        description: 'Fixed group insurance deduction amount',
        value: '0',
        dataType: ConfigDataType.NUMBER,
        category: ConfigCategory.BUSINESS_RULES,
        unit: 'INR',
      },
      {
        key: 'RULE_CD_INTEREST_CHART',
        name: 'Monthly Contribution Interest Chart',
        description: 'Chart defining yearly interest for monthly fixed deposits',
        value: '[]',
        dataType: ConfigDataType.JSON,
        category: ConfigCategory.BUSINESS_RULES,
        unit: '',
      },
    ];

    for (const configData of defaultConfigs) {
      const existingConfig = await this.systemConfigRepository.findOne({
        where: { key: configData.key },
      });

      if (!existingConfig) {
        const config = this.systemConfigRepository.create(configData);
        await this.systemConfigRepository.save(config);
      }
    }
  }

  private validateConfigValue(value: string, dataType: ConfigDataType, validationRules?: string): void {
    switch (dataType) {
      case ConfigDataType.NUMBER:
      case ConfigDataType.PERCENTAGE:
        const numValue = parseFloat(value);
        if (isNaN(numValue)) {
          throw new BadRequestException('Invalid number value');
        }
        break;
      case ConfigDataType.BOOLEAN:
        if (value !== 'true' && value !== 'false') {
          throw new BadRequestException('Invalid boolean value');
        }
        break;
      case ConfigDataType.JSON:
        try {
          JSON.parse(value);
        } catch {
          throw new BadRequestException('Invalid JSON value');
        }
        break;
    }

    // Apply validation rules if provided
    if (validationRules) {
      try {
        const rules = JSON.parse(validationRules);
        const typedValue = dataType === ConfigDataType.NUMBER || dataType === ConfigDataType.PERCENTAGE
          ? parseFloat(value)
          : value;

        if (rules.min !== undefined && typedValue < rules.min) {
          throw new BadRequestException(`Value must be at least ${rules.min}`);
        }
        if (rules.max !== undefined && typedValue > rules.max) {
          throw new BadRequestException(`Value must be at most ${rules.max}`);
        }
      } catch (error) {
        if (error instanceof BadRequestException) {
          throw error;
        }
        // Ignore invalid validation rules
      }
    }
  }

  private mapConfigToResponseDto(config: SystemConfig): SystemConfigResponseDto {
    return {
      id: config.id,
      key: config.key,
      name: config.name,
      description: config.description,
      value: config.value,
      typedValue: config.getTypedValue(),
      dataType: config.dataType,
      category: config.category,
      isActive: config.isActive,
      isReadonly: config.isReadonly,
      validationRules: config.validationRules,
      defaultValue: config.defaultValue,
      unit: config.unit,
      createdAt: config.createdAt,
      updatedAt: config.updatedAt,
    };
  }
}
