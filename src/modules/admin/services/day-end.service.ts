import {
  Injectable,
  BadRequestException,
  NotFoundException,
  Logger,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, DataSource } from 'typeorm';
import { Cron, CronExpression } from '@nestjs/schedule';
import {
  DayEndProcess,
  DayEndStatus,
  DayEndProcessType,
  DayEndProcessStep,
} from '../entities/day-end-process.entity';
import {
  InterestPosting,
  InterestPostingType,
  InterestPostingStatus,
} from '../entities/interest-posting.entity';
import { LoanAccount } from '../../loan/entities/loan-account.entity';
import { FixedDeposit } from '../../deposit/entities/fixed-deposit.entity';
import { Member } from '../../member/entities/member.entity';
import {
  InitiateDayEndDto,
  DayEndProcessResponseDto,
  DayEndSummaryDto,
  InterestCalculationResultDto,
} from '../dto';
import { BackupService } from './backup.service';
import * as fs from 'fs';
import * as path from 'path';

@Injectable()
export class DayEndService {
  private readonly logger = new Logger(DayEndService.name);

  constructor(
    @InjectRepository(DayEndProcess)
    private dayEndProcessRepository: Repository<DayEndProcess>,
    @InjectRepository(InterestPosting)
    private interestPostingRepository: Repository<InterestPosting>,
    @InjectRepository(LoanAccount)
    private loanAccountRepository: Repository<LoanAccount>,
    @InjectRepository(FixedDeposit)
    private fixedDepositRepository: Repository<FixedDeposit>,
    @InjectRepository(Member)
    private memberRepository: Repository<Member>,
    private dataSource: DataSource,
    private backupService: BackupService,
  ) {}

  async initiateDayEnd(
    initiateDayEndDto: InitiateDayEndDto,
    userId: number,
  ): Promise<DayEndProcessResponseDto> {
    const processDate = new Date(initiateDayEndDto.processDate);
    
    // Check if day-end already completed for this date
    if (!initiateDayEndDto.forceReprocess) {
      const existingProcess = await this.dayEndProcessRepository.findOne({
        where: {
          processDate,
          status: DayEndStatus.COMPLETED,
        },
      });

      if (existingProcess) {
        throw new BadRequestException(
          `Day-end processing already completed for ${processDate.toDateString()}`,
        );
      }
    }

    // Check if there's an ongoing process
    const ongoingProcess = await this.dayEndProcessRepository.findOne({
      where: {
        status: DayEndStatus.IN_PROGRESS,
      },
    });

    if (ongoingProcess) {
      throw new BadRequestException('Another day-end process is currently in progress');
    }

    // Create new day-end process
    const processSteps = this.getProcessSteps(initiateDayEndDto.processTypes);
    const dayEndProcess = this.dayEndProcessRepository.create({
      processDate,
      status: DayEndStatus.IN_PROGRESS,
      startedAt: new Date(),
      initiatedBy: userId,
      processSteps,
    });

    const savedProcess = await this.dayEndProcessRepository.save(dayEndProcess);

    // Start processing asynchronously
    this.executeDayEndProcess(savedProcess.id).catch(error => {
      this.logger.error(`Day-end process ${savedProcess.id} failed:`, error);
    });

    return this.mapToResponseDto(savedProcess);
  }

  async getDayEndProcess(id: number): Promise<DayEndProcessResponseDto> {
    const process = await this.dayEndProcessRepository.findOne({
      where: { id },
    });

    if (!process) {
      throw new NotFoundException('Day-end process not found');
    }

    return this.mapToResponseDto(process);
  }

  async getDayEndProcesses(
    page: number = 1,
    limit: number = 10,
  ): Promise<{
    processes: DayEndProcessResponseDto[];
    total: number;
    page: number;
    limit: number;
    totalPages: number;
  }> {
    const [processes, total] = await this.dayEndProcessRepository.findAndCount({
      skip: (page - 1) * limit,
      take: limit,
      order: { processDate: 'DESC' },
    });

    return {
      processes: processes.map(process => this.mapToResponseDto(process)),
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    };
  }

  async getDayEndSummary(processId: number): Promise<DayEndSummaryDto> {
    const process = await this.dayEndProcessRepository.findOne({
      where: { id: processId },
    });

    if (!process) {
      throw new NotFoundException('Day-end process not found');
    }

    const totalSteps = process.processSteps?.length || 0;
    const completedSteps = process.processSteps?.filter(
      step => step.status === DayEndStatus.COMPLETED,
    ).length || 0;
    const failedSteps = process.processSteps?.filter(
      step => step.status === DayEndStatus.FAILED,
    ).length || 0;

    return {
      processDate: process.processDate,
      totalSteps,
      completedSteps,
      failedSteps,
      overallStatus: process.status,
      duration: process.getDuration(),
      interestCalculations: process.processResults?.interestCalculations,
      backupInfo: process.processResults?.backupInfo,
      validationResults: process.processResults?.validationResults,
    };
  }

  async getInterestCalculationResults(
    processId: number,
  ): Promise<InterestCalculationResultDto[]> {
    const process = await this.dayEndProcessRepository.findOne({
      where: { id: processId },
    });

    if (!process) {
      throw new NotFoundException('Day-end process not found');
    }

    const interestPostings = await this.interestPostingRepository.find({
      where: {
        calculationDate: process.processDate,
      },
      relations: ['member'],
    });

    return interestPostings.map(posting => ({
      accountId: posting.accountId,
      accountNumber: posting.accountNumber,
      memberName: posting.member ? `${posting.member.firstName} ${posting.member.lastName}` : 'Unknown',
      principalAmount: posting.principalAmount,
      interestRate: posting.interestRate,
      interestAmount: posting.interestAmount,
      calculationDate: posting.calculationDate,
      status: posting.status,
    }));
  }

  // Automated day-end processing (runs at 11:30 PM daily)
  @Cron('30 23 * * *')
  async automaticDayEndProcessing() {
    try {
      const today = new Date();
      today.setHours(0, 0, 0, 0);

      // Check if day-end already completed for today
      const existingProcess = await this.dayEndProcessRepository.findOne({
        where: {
          processDate: today,
          status: DayEndStatus.COMPLETED,
        },
      });

      if (existingProcess) {
        this.logger.log(`Day-end already completed for ${today.toDateString()}`);
        return;
      }

      // Check if there's an ongoing process
      const ongoingProcess = await this.dayEndProcessRepository.findOne({
        where: {
          status: DayEndStatus.IN_PROGRESS,
        },
      });

      if (ongoingProcess) {
        this.logger.warn('Skipping automatic day-end: another process is in progress');
        return;
      }

      this.logger.log('Starting automatic day-end processing');
      await this.initiateDayEnd(
        {
          processDate: today.toISOString().split('T')[0],
        },
        0, // System user
      );
    } catch (error) {
      this.logger.error('Automatic day-end processing failed:', error);
    }
  }

  private async executeDayEndProcess(processId: number): Promise<void> {
    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();

    try {
      const process = await this.dayEndProcessRepository.findOne({
        where: { id: processId },
      });

      if (!process) {
        throw new Error('Process not found');
      }

      const results: any = {};
      const steps = [...(process.processSteps || [])];

      // Execute each step
      for (let i = 0; i < steps.length; i++) {
        const step = steps[i];
        this.logger.log(`Executing step: ${step.name}`);

        try {
          step.status = DayEndStatus.IN_PROGRESS;
          step.startedAt = new Date();

          let stepResult: any;
          switch (step.type) {
            case DayEndProcessType.INTEREST_CALCULATION:
              stepResult = await this.calculateInterest(process.processDate, queryRunner);
              break;
            case DayEndProcessType.BACKUP_CREATION:
              stepResult = await this.createBackup(process.processDate);
              break;
            case DayEndProcessType.REPORT_GENERATION:
              stepResult = await this.generateReports(process.processDate);
              break;
            case DayEndProcessType.DATA_VALIDATION:
              stepResult = await this.validateData(process.processDate, queryRunner);
              break;
            case DayEndProcessType.SYSTEM_CLEANUP:
              stepResult = await this.performSystemCleanup(process.processDate);
              break;
            default:
              throw new Error(`Unknown process type: ${step.type}`);
          }

          step.status = DayEndStatus.COMPLETED;
          step.completedAt = new Date();
          step.result = stepResult;
          results[step.type] = stepResult;

          this.logger.log(`Step completed: ${step.name}`);
        } catch (error) {
          step.status = DayEndStatus.FAILED;
          step.errorMessage = error.message;
          this.logger.error(`Step failed: ${step.name}`, error);
          throw error;
        }

        // Update process with current step status
        process.processSteps = steps;
        await this.dayEndProcessRepository.save(process);
      }

      // All steps completed successfully
      process.status = DayEndStatus.COMPLETED;
      process.completedAt = new Date();
      process.processResults = results;
      await this.dayEndProcessRepository.save(process);

      await queryRunner.commitTransaction();
      this.logger.log(`Day-end process ${processId} completed successfully`);
    } catch (error) {
      await queryRunner.rollbackTransaction();
      
      // Update process as failed
      const process = await this.dayEndProcessRepository.findOne({
        where: { id: processId },
      });
      
      if (process) {
        process.status = DayEndStatus.FAILED;
        process.failedAt = new Date();
        process.errorMessage = error.message;
        await this.dayEndProcessRepository.save(process);
      }

      this.logger.error(`Day-end process ${processId} failed:`, error);
      throw error;
    } finally {
      await queryRunner.release();
    }
  }

  private async calculateInterest(processDate: Date, queryRunner: any): Promise<any> {
    const results = {
      loansProcessed: 0,
      depositsProcessed: 0,
      totalInterestPosted: 0,
    };

    // Calculate loan interest
    const activeLoans = await this.loanAccountRepository.find({
      where: { status: 'ACTIVE' },
      relations: ['member'],
    });

    for (const loan of activeLoans) {
      if (loan.outstandingBalance > 0) {
        const dailyInterestRate = loan.interestRate / 365 / 100;
        const interestAmount = loan.outstandingBalance * dailyInterestRate;

        const interestPosting = this.interestPostingRepository.create({
          memberId: loan.member.id,
          accountId: loan.id,
          accountNumber: loan.accountNumber,
          type: InterestPostingType.LOAN_INTEREST,
          principalAmount: loan.outstandingBalance,
          interestRate: loan.interestRate,
          interestAmount,
          calculationDate: processDate,
          postingDate: processDate,
          status: InterestPostingStatus.POSTED,
          remarks: 'Daily interest calculation',
        });

        await queryRunner.manager.save(interestPosting);
        
        // Update loan outstanding balance
        loan.outstandingBalance += interestAmount;
        await queryRunner.manager.save(loan);

        results.loansProcessed++;
        results.totalInterestPosted += interestAmount;
      }
    }

    // Calculate deposit interest
    const activeDeposits = await this.fixedDepositRepository.find({
      where: { status: 'ACTIVE' },
      relations: ['member'],
    });

    for (const deposit of activeDeposits) {
      const dailyInterestRate = deposit.interestRate / 365 / 100;
      const interestAmount = deposit.principalAmount * dailyInterestRate;

      const interestPosting = this.interestPostingRepository.create({
        memberId: deposit.member.id,
        accountId: deposit.id,
        accountNumber: deposit.accountNumber,
        type: InterestPostingType.DEPOSIT_INTEREST,
        principalAmount: deposit.principalAmount,
        interestRate: deposit.interestRate,
        interestAmount,
        calculationDate: processDate,
        postingDate: processDate,
        status: InterestPostingStatus.POSTED,
        remarks: 'Daily interest calculation',
      });

      await queryRunner.manager.save(interestPosting);

      results.depositsProcessed++;
      results.totalInterestPosted += interestAmount;
    }

    return results;
  }

  private async createBackup(processDate: Date): Promise<any> {
    const backupResult = await this.backupService.createDatabaseBackup(
      `dayend_${processDate.toISOString().split('T')[0]}`,
    );

    return {
      backupSize: backupResult.size,
      backupPath: backupResult.path,
      backupTime: new Date(),
    };
  }

  private async generateReports(processDate: Date): Promise<any> {
    // This would integrate with the report service to generate daily reports
    // For now, return a placeholder
    return {
      reportsGenerated: [
        'daily_cash_book',
        'daily_transaction_summary',
        'interest_posting_report',
      ],
      reportPath: `/reports/daily/${processDate.toISOString().split('T')[0]}`,
    };
  }

  private async validateData(processDate: Date, queryRunner: any): Promise<any> {
    const validationResults = {
      totalChecks: 0,
      passedChecks: 0,
      failedChecks: 0,
      warnings: [] as string[],
    };

    // Validate loan balances
    const loans = await queryRunner.manager.find(LoanAccount, {
      where: { status: 'ACTIVE' },
    });

    for (const loan of loans) {
      validationResults.totalChecks++;
      if (loan.outstandingBalance < 0) {
        validationResults.failedChecks++;
        validationResults.warnings.push(
          `Loan ${loan.accountNumber} has negative outstanding balance`,
        );
      } else {
        validationResults.passedChecks++;
      }
    }

    // Validate deposit amounts
    const deposits = await queryRunner.manager.find(FixedDeposit, {
      where: { status: 'ACTIVE' },
    });

    for (const deposit of deposits) {
      validationResults.totalChecks++;
      if (deposit.principalAmount <= 0) {
        validationResults.failedChecks++;
        validationResults.warnings.push(
          `Deposit ${deposit.accountNumber} has invalid principal amount`,
        );
      } else {
        validationResults.passedChecks++;
      }
    }

    return validationResults;
  }

  private async performSystemCleanup(processDate: Date): Promise<any> {
    // Clean up temporary files, logs, etc.
    const cleanupResults = {
      tempFilesDeleted: 0,
      oldLogsDeleted: 0,
      cacheCleared: true,
    };

    // This is a placeholder for actual cleanup operations
    return cleanupResults;
  }

  private getProcessSteps(processTypes?: DayEndProcessType[]): DayEndProcessStep[] {
    const allSteps: DayEndProcessStep[] = [
      {
        type: DayEndProcessType.DATA_VALIDATION,
        name: 'Data Validation',
        status: DayEndStatus.PENDING,
      },
      {
        type: DayEndProcessType.INTEREST_CALCULATION,
        name: 'Interest Calculation',
        status: DayEndStatus.PENDING,
      },
      {
        type: DayEndProcessType.REPORT_GENERATION,
        name: 'Report Generation',
        status: DayEndStatus.PENDING,
      },
      {
        type: DayEndProcessType.BACKUP_CREATION,
        name: 'Backup Creation',
        status: DayEndStatus.PENDING,
      },
      {
        type: DayEndProcessType.SYSTEM_CLEANUP,
        name: 'System Cleanup',
        status: DayEndStatus.PENDING,
      },
    ];

    if (processTypes && processTypes.length > 0) {
      return allSteps.filter(step => processTypes.includes(step.type));
    }

    return allSteps;
  }

  private mapToResponseDto(process: DayEndProcess): DayEndProcessResponseDto {
    return {
      id: process.id,
      processDate: process.processDate,
      status: process.status,
      startedAt: process.startedAt,
      completedAt: process.completedAt,
      failedAt: process.failedAt,
      errorMessage: process.errorMessage,
      processResults: process.processResults,
      processSteps: process.processSteps,
      initiatedBy: process.initiatedBy,
      duration: process.getDuration(),
      createdAt: process.createdAt,
      updatedAt: process.updatedAt,
    };
  }
}
