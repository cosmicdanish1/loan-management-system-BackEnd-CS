import {
  Injectable,
  Logger,
  BadRequestException,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, DataSource, QueryRunner } from 'typeorm';
import { LoanAccount } from '../../loan/entities/loan-account.entity';
import { FixedDeposit } from '../../deposit/entities/fixed-deposit.entity';
import { InterestRate, InterestRateType } from '../../admin/entities/interest-rate.entity';
import { SystemConfigService } from '../../admin/services/system-config.service';

export interface InterestRateUpdateDto {
  rateType: InterestRateType;
  newRate: number;
  effectiveDate: Date;
  applyToExisting: boolean;
  accountIds?: number[];
  minAmount?: number;
  maxAmount?: number;
  tenure?: number;
}

export interface InterestRateUpdateResult {
  success: boolean;
  message: string;
  affectedAccounts: number;
  updatedAccounts: number[];
  errors: string[];
  rollbackAvailable: boolean;
}

export interface BulkInterestRateUpdate {
  loanRates?: { [key: string]: number };
  depositRates?: { [key: string]: number };
  effectiveDate: Date;
  applyToExisting: boolean;
}

@Injectable()
export class InterestRateUpdateService {
  private readonly logger = new Logger(InterestRateUpdateService.name);

  constructor(
    @InjectRepository(LoanAccount)
    private loanAccountRepository: Repository<LoanAccount>,
    @InjectRepository(FixedDeposit)
    private fixedDepositRepository: Repository<FixedDeposit>,
    @InjectRepository(InterestRate)
    private interestRateRepository: Repository<InterestRate>,
    private systemConfigService: SystemConfigService,
    private dataSource: DataSource,
  ) {}

  /**
   * Update interest rates for specific account type
   */
  async updateInterestRates(updateDto: InterestRateUpdateDto): Promise<InterestRateUpdateResult> {
    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();

    try {
      this.logger.log(`Starting interest rate update for ${updateDto.rateType}`);

      // Validate the new rate
      this.validateInterestRate(updateDto.newRate, updateDto.rateType);

      // Create new interest rate configuration
      const newInterestRate = await this.createInterestRateConfig(
        updateDto,
        queryRunner,
      );

      let affectedAccounts = 0;
      const updatedAccounts: number[] = [];
      const errors: string[] = [];

      if (updateDto.applyToExisting) {
        // Apply to existing accounts
        const result = await this.applyRateToExistingAccounts(
          updateDto,
          queryRunner,
        );
        affectedAccounts = result.affectedAccounts;
        updatedAccounts.push(...result.updatedAccounts);
        errors.push(...result.errors);
      }

      await queryRunner.commitTransaction();

      this.logger.log(
        `Interest rate update completed. Affected accounts: ${affectedAccounts}`,
      );

      return {
        success: true,
        message: `Interest rate updated successfully for ${updateDto.rateType}`,
        affectedAccounts,
        updatedAccounts,
        errors,
        rollbackAvailable: true,
      };
    } catch (error) {
      await queryRunner.rollbackTransaction();
      this.logger.error('Interest rate update failed', error.stack);

      return {
        success: false,
        message: `Interest rate update failed: ${error.message}`,
        affectedAccounts: 0,
        updatedAccounts: [],
        errors: [error.message],
        rollbackAvailable: false,
      };
    } finally {
      await queryRunner.release();
    }
  }

  /**
   * Bulk update multiple interest rates
   */
  async bulkUpdateInterestRates(
    bulkUpdate: BulkInterestRateUpdate,
  ): Promise<InterestRateUpdateResult[]> {
    const results: InterestRateUpdateResult[] = [];

    // Update loan rates
    if (bulkUpdate.loanRates) {
      for (const [loanType, rate] of Object.entries(bulkUpdate.loanRates)) {
        const updateDto: InterestRateUpdateDto = {
          rateType: InterestRateType.LOAN,
          newRate: rate,
          effectiveDate: bulkUpdate.effectiveDate,
          applyToExisting: bulkUpdate.applyToExisting,
        };

        const result = await this.updateInterestRates(updateDto);
        results.push(result);
      }
    }

    // Update deposit rates
    if (bulkUpdate.depositRates) {
      for (const [depositType, rate] of Object.entries(bulkUpdate.depositRates)) {
        const updateDto: InterestRateUpdateDto = {
          rateType: InterestRateType.FIXED_DEPOSIT,
          newRate: rate,
          effectiveDate: bulkUpdate.effectiveDate,
          applyToExisting: bulkUpdate.applyToExisting,
        };

        const result = await this.updateInterestRates(updateDto);
        results.push(result);
      }
    }

    return results;
  }

  /**
   * Get current interest rates summary
   */
  async getCurrentInterestRates(): Promise<any> {
    const activeRates = await this.interestRateRepository.find({
      where: { isActive: true },
      order: { type: 'ASC', effectiveFrom: 'DESC' },
    });

    const ratesSummary = {
      loanRates: activeRates.filter(r => r.type === InterestRateType.LOAN),
      depositRates: activeRates.filter(r => r.type === InterestRateType.FIXED_DEPOSIT),
      rdRates: activeRates.filter(r => r.type === InterestRateType.RECURRING_DEPOSIT),
      shareRates: activeRates.filter(r => r.type === InterestRateType.SAVINGS),
      lastUpdated: activeRates.length > 0 ? activeRates[0].updatedAt : null,
    };

    return ratesSummary;
  }

  /**
   * Recalculate interest for affected accounts
   */
  async recalculateInterestForAccounts(
    accountType: 'loan' | 'deposit',
    accountIds: number[],
    effectiveDate: Date,
  ): Promise<{ success: boolean; recalculatedAccounts: number; errors: string[] }> {
    const errors: string[] = [];
    let recalculatedAccounts = 0;

    try {
      if (accountType === 'loan') {
        for (const accountId of accountIds) {
          try {
            await this.recalculateLoanInterest(accountId, effectiveDate);
            recalculatedAccounts++;
          } catch (error) {
            errors.push(`Loan ${accountId}: ${error.message}`);
          }
        }
      } else if (accountType === 'deposit') {
        for (const accountId of accountIds) {
          try {
            await this.recalculateDepositInterest(accountId, effectiveDate);
            recalculatedAccounts++;
          } catch (error) {
            errors.push(`Deposit ${accountId}: ${error.message}`);
          }
        }
      }

      return {
        success: errors.length === 0,
        recalculatedAccounts,
        errors,
      };
    } catch (error) {
      this.logger.error('Interest recalculation failed', error.stack);
      return {
        success: false,
        recalculatedAccounts,
        errors: [error.message],
      };
    }
  }

  /**
   * Preview interest rate update impact
   */
  async previewInterestRateUpdate(
    updateDto: InterestRateUpdateDto,
  ): Promise<{
    affectedAccountsCount: number;
    estimatedImpact: any[];
    potentialErrors: string[];
  }> {
    try {
      let affectedAccounts: any[] = [];
      const potentialErrors: string[] = [];

      if (updateDto.rateType === InterestRateType.LOAN) {
        const query = this.loanAccountRepository.createQueryBuilder('loan')
          .leftJoinAndSelect('loan.member', 'member')
          .where('loan.status = :status', { status: 'ACTIVE' });

        if (updateDto.accountIds?.length) {
          query.andWhere('loan.id IN (:...ids)', { ids: updateDto.accountIds });
        }

        if (updateDto.minAmount) {
          query.andWhere('loan.outstandingBalance >= :minAmount', {
            minAmount: updateDto.minAmount,
          });
        }

        if (updateDto.maxAmount) {
          query.andWhere('loan.outstandingBalance <= :maxAmount', {
            maxAmount: updateDto.maxAmount,
          });
        }

        affectedAccounts = await query.getMany();
      } else if (updateDto.rateType === InterestRateType.FIXED_DEPOSIT) {
        const query = this.fixedDepositRepository.createQueryBuilder('fd')
          .leftJoinAndSelect('fd.member', 'member')
          .where('fd.status = :status', { status: 'ACTIVE' });

        if (updateDto.accountIds?.length) {
          query.andWhere('fd.id IN (:...ids)', { ids: updateDto.accountIds });
        }

        if (updateDto.minAmount) {
          query.andWhere('fd.principalAmount >= :minAmount', {
            minAmount: updateDto.minAmount,
          });
        }

        if (updateDto.maxAmount) {
          query.andWhere('fd.principalAmount <= :maxAmount', {
            maxAmount: updateDto.maxAmount,
          });
        }

        affectedAccounts = await query.getMany();
      }

      // Calculate estimated impact
      const estimatedImpact = affectedAccounts.map(account => {
        const currentRate = account.interestRate || 0;
        const rateDifference = updateDto.newRate - currentRate;
        const principal = account.outstandingBalance || account.principalAmount || 0;
        const annualImpact = (principal * rateDifference) / 100;

        return {
          accountId: account.id,
          accountNumber: account.accountNumber,
          memberName: account.member ? `${account.member.firstName} ${account.member.lastName}` : 'Unknown',
          currentRate,
          newRate: updateDto.newRate,
          rateDifference,
          principalAmount: principal,
          estimatedAnnualImpact: annualImpact,
        };
      });

      return {
        affectedAccountsCount: affectedAccounts.length,
        estimatedImpact,
        potentialErrors,
      };
    } catch (error) {
      this.logger.error('Preview calculation failed', error.stack);
      throw new BadRequestException('Failed to calculate preview');
    }
  }

  private validateInterestRate(rate: number, type: InterestRateType): void {
    if (rate < 0 || rate > 100) {
      throw new BadRequestException('Interest rate must be between 0 and 100');
    }

    // Additional validation based on type
    if (type === InterestRateType.LOAN && rate > 50) {
      throw new BadRequestException('Loan interest rate seems unusually high');
    }

    if (type === InterestRateType.FIXED_DEPOSIT && rate > 20) {
      throw new BadRequestException('Deposit interest rate seems unusually high');
    }
  }

  private async createInterestRateConfig(
    updateDto: InterestRateUpdateDto,
    queryRunner: QueryRunner,
  ): Promise<InterestRate> {
    // Deactivate existing rates of the same type
    await queryRunner.manager.update(
      InterestRate,
      { type: updateDto.rateType, isActive: true },
      { isActive: false, effectiveTo: updateDto.effectiveDate },
    );

    // Create new rate configuration
    const newRate = queryRunner.manager.create(InterestRate, {
      type: updateDto.rateType,
      rate: updateDto.newRate,
      effectiveFrom: updateDto.effectiveDate,
      isActive: true,
      minAmount: updateDto.minAmount || 0,
      maxAmount: updateDto.maxAmount || 999999999,
      minTenure: updateDto.tenure || 0,
      maxTenure: updateDto.tenure || 999,
    });

    return queryRunner.manager.save(InterestRate, newRate);
  }

  private async applyRateToExistingAccounts(
    updateDto: InterestRateUpdateDto,
    queryRunner: QueryRunner,
  ): Promise<{
    affectedAccounts: number;
    updatedAccounts: number[];
    errors: string[];
  }> {
    const updatedAccounts: number[] = [];
    const errors: string[] = [];

    if (updateDto.rateType === InterestRateType.LOAN) {
      const query = queryRunner.manager.createQueryBuilder()
        .update(LoanAccount)
        .set({ interestRate: updateDto.newRate })
        .where('status = :status', { status: 'ACTIVE' });

      if (updateDto.accountIds?.length) {
        query.andWhere('id IN (:...ids)', { ids: updateDto.accountIds });
      }

      const result = await query.execute();
      return {
        affectedAccounts: result.affected || 0,
        updatedAccounts: updateDto.accountIds || [],
        errors,
      };
    } else if (updateDto.rateType === InterestRateType.FIXED_DEPOSIT) {
      const query = queryRunner.manager.createQueryBuilder()
        .update(FixedDeposit)
        .set({ interestRate: updateDto.newRate })
        .where('status = :status', { status: 'ACTIVE' });

      if (updateDto.accountIds?.length) {
        query.andWhere('id IN (:...ids)', { ids: updateDto.accountIds });
      }

      const result = await query.execute();
      return {
        affectedAccounts: result.affected || 0,
        updatedAccounts: updateDto.accountIds || [],
        errors,
      };
    }

    return { affectedAccounts: 0, updatedAccounts, errors };
  }

  private async recalculateLoanInterest(
    loanId: number,
    effectiveDate: Date,
  ): Promise<void> {
    const loan = await this.loanAccountRepository.findOne({
      where: { id: loanId },
    });

    if (!loan) {
      throw new NotFoundException(`Loan account ${loanId} not found`);
    }

    // Recalculate interest based on new rate
    // This would involve complex interest calculation logic
    // For now, we'll just update the loan record
    await this.loanAccountRepository.save(loan);
  }

  private async recalculateDepositInterest(
    depositId: number,
    effectiveDate: Date,
  ): Promise<void> {
    const deposit = await this.fixedDepositRepository.findOne({
      where: { id: depositId },
    });

    if (!deposit) {
      throw new NotFoundException(`Deposit account ${depositId} not found`);
    }

    // Recalculate maturity amount based on new rate
    const daysDiff = Math.ceil(
      (deposit.maturityDate.getTime() - deposit.depositDate.getTime()) / (1000 * 60 * 60 * 24),
    );
    const years = daysDiff / 365;
    deposit.maturityAmount = deposit.principalAmount * Math.pow(1 + deposit.interestRate / 100, years);

    await this.fixedDepositRepository.save(deposit);
  }
}
