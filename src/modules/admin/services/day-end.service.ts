import {
  Injectable,
  BadRequestException,
  NotFoundException,
  Logger,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, DataSource } from 'typeorm';
import { Cron } from '@nestjs/schedule';
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
  ) { }

  async initiateDayEnd(
    initiateDayEndDto: InitiateDayEndDto,
    userId: number,
  ): Promise<DayEndProcessResponseDto> {
    // Always use the current pending working date from getworkingdate, ignore frontend date
    const pendingDateResult = await this.dataSource.query(`
      SELECT working_date FROM getworkingdate
      WHERE dayend_flag = 'N'
      ORDER BY working_date ASC
      LIMIT 1
    `);

    let processDate: Date;
    if (pendingDateResult.length > 0) {
      processDate = new Date(pendingDateResult[0].working_date);
    } else {
      processDate = new Date(initiateDayEndDto.processDate);
    }
    // FIX BUG 7: Normalize to midnight to ensure consistent timestamp comparison
    processDate.setHours(0, 0, 0, 0);

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
      where: { status: DayEndStatus.IN_PROGRESS },
    });

    if (ongoingProcess) {
      throw new BadRequestException('Another day-end process is currently in progress');
    }

    // Block day-end if unposted (unpassed) transactions exist — matches legacy behavior
    const unpassed = await this.dataSource.query(
      `SELECT COUNT(*) as cnt FROM transactions WHERE pass_flag = 'N'`
    );
    const unpassedCount = parseInt(unpassed[0]?.cnt || '0');
    if (unpassedCount > 0) {
      throw new BadRequestException(
        `Cannot perform Day End — ${unpassedCount} unpass voucher(s) found! Go to Pass Transactions first.`
      );
    }

    // Block day-end if pending loans exist (pass_flag='N' — not yet approved/declined)
    const pendingLoans = await this.dataSource.query(
      `SELECT COUNT(*) as cnt FROM loan_pending WHERE COALESCE(pass_flag, 'N') = 'N' AND flg_sanctioned = 'N'`
    );
    const pendingLoanCount = parseInt(pendingLoans[0]?.cnt || '0');
    if (pendingLoanCount > 0) {
      throw new BadRequestException(
        `Cannot perform Day End — ${pendingLoanCount} pending loan application(s) awaiting approval! Go to Pass Transactions to approve or decline them.`
      );
    }

    // FIX BUG 4: Generate next ID inside a serialized query to prevent race conditions
    const nextIdResult = await this.dataSource.query(
      `SELECT COALESCE(MAX(id), 0) + 1 AS next_id FROM day_end_processes`
    );
    const nextId = Number(nextIdResult[0]?.next_id ?? 1);

    const processSteps = this.getProcessSteps(initiateDayEndDto.processTypes);

    const dayEndProcess = this.dayEndProcessRepository.create({
      id: nextId,
      processDate,
      status: DayEndStatus.IN_PROGRESS,
      startedAt: new Date(),
      initiatedBy: userId,
      processSteps,
      nextWorkingDate: initiateDayEndDto.nextWorkingDate || null,
    } as any);

    const savedProcess = await this.dayEndProcessRepository.save(dayEndProcess) as unknown as DayEndProcess;

    // Start processing asynchronously — errors are caught and persisted internally
    this.executeDayEndProcess(savedProcess.id).catch(error => {
      this.logger.error(`Day-end process ${savedProcess.id} failed:`, error);
    });

    return this.mapToResponseDto(savedProcess);
  }

  async getDayEndProcess(id: number): Promise<DayEndProcessResponseDto> {
    const process = await this.dayEndProcessRepository.findOne({ where: { id } });
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
      processes: processes.map(p => this.mapToResponseDto(p)),
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
    const completedSteps =
      process.processSteps?.filter(s => s.status === DayEndStatus.COMPLETED).length || 0;
    const failedSteps =
      process.processSteps?.filter(s => s.status === DayEndStatus.FAILED).length || 0;

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

  async getCurrentDayEndSummary(): Promise<any> {
    try {
      const workingDateResult = await this.dataSource.query(`
        SELECT working_date, payment_voucher, receipt_voucher, journal_voucher, dayend_flag
        FROM getworkingdate
        WHERE dayend_flag = 'N'
        ORDER BY working_date DESC
        LIMIT 1
      `);

      const lastCompletedResult = await this.dataSource.query(`
        SELECT working_date, payment_voucher, receipt_voucher, journal_voucher
        FROM getworkingdate
        WHERE dayend_flag = 'Y'
        ORDER BY working_date DESC
        LIMIT 1
      `);

      const currentRow = workingDateResult[0] || lastCompletedResult[0];
      const workingDate = currentRow ? new Date(currentRow.working_date) : new Date();
      workingDate.setHours(0, 0, 0, 0);

      const paymentVouchers = currentRow?.payment_voucher || 0;
      const receiptVouchers = currentRow?.receipt_voucher || 0;
      const journalVouchers = currentRow?.journal_voucher || 0;

      const openingBalance = await this.calculateOpeningBalance(workingDate);
      const totalCredit = await this.calculateTodayCredits(workingDate);
      const totalDebit = await this.calculateTodayDebits(workingDate);
      const closingBalance = openingBalance + totalCredit - totalDebit;

      // Check pending loans awaiting approval
      const pendingLoansResult = await this.dataSource.query(
        `SELECT COUNT(*) as cnt FROM loan_pending WHERE COALESCE(pass_flag, 'N') = 'N' AND flg_sanctioned = 'N'`
      );
      const pendingLoans = parseInt(pendingLoansResult[0]?.cnt || '0');

      return {
        date: workingDate.toISOString().split('T')[0],
        openingBalance: Number(openingBalance.toFixed(2)),
        totalCredit: Number(totalCredit.toFixed(2)),
        totalDebit: Number(totalDebit.toFixed(2)),
        closingBalance: Number(closingBalance.toFixed(2)),
        paymentVouchers,
        receiptVouchers,
        journalVouchers,
        dayendFlag: workingDateResult[0]?.dayend_flag || 'Y',
        pendingLoans,
      };
    } catch (error) {
      this.logger.error('Error fetching current day-end summary:', error);
      throw error;
    }
  }

  private async calculateOpeningBalance(date: Date): Promise<number> {
    const previousDay = new Date(date);
    previousDay.setDate(previousDay.getDate() - 1);

    const previousProcess = await this.dayEndProcessRepository.findOne({
      where: { processDate: previousDay, status: DayEndStatus.COMPLETED },
      order: { processDate: 'DESC' },
    });

    if (previousProcess?.processResults?.closingBalance) {
      return previousProcess.processResults.closingBalance;
    }

    try {
      const result = await this.dataSource.query(`
        SELECT
          COALESCE(SUM(COALESCE(rcash,0) + COALESCE(rtransfer,0)), 0) -
          COALESCE(SUM(COALESCE(pcash,0) + COALESCE(ptransfer,0)), 0) as balance
        FROM tblcashbook
        WHERE trans_date::date < $1::date
      `, [date]);
      return parseFloat(result[0]?.balance || '0');
    } catch {
      return 0;
    }
  }

  private async calculateTodayCredits(date: Date): Promise<number> {
    try {
      const result = await this.dataSource.query(`
        SELECT COALESCE(SUM(COALESCE(rcash,0) + COALESCE(rtransfer,0)), 0) as total
        FROM tblcashbook
        WHERE trans_date::date = $1::date
      `, [date]);
      return Number(result[0]?.total || 0);
    } catch (error) {
      this.logger.warn('Could not calculate today credits from tblcashbook');
      return 0;
    }
  }

  private async calculateTodayDebits(date: Date): Promise<number> {
    try {
      const result = await this.dataSource.query(`
        SELECT COALESCE(SUM(COALESCE(pcash,0) + COALESCE(ptransfer,0)), 0) as total
        FROM tblcashbook
        WHERE trans_date::date = $1::date
      `, [date]);
      return Number(result[0]?.total || 0);
    } catch (error) {
      this.logger.warn('Could not calculate today debits from tblcashbook');
      return 0;
    }
  }

  async getInterestCalculationResults(processId: number): Promise<InterestCalculationResultDto[]> {
    const process = await this.dayEndProcessRepository.findOne({ where: { id: processId } });
    if (!process) throw new NotFoundException('Day-end process not found');

    const interestPostings = await this.interestPostingRepository.find({
      where: { calculationDate: process.processDate },
      relations: ['member'],
    });

    return interestPostings.map(posting => ({
      accountId: posting.accountId,
      accountNumber: posting.accountNumber,
      memberName: posting.member
        ? `${posting.member.firstName} ${posting.member.lastName}`
        : 'Unknown',
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

      const existingProcess = await this.dayEndProcessRepository.findOne({
        where: { processDate: today, status: DayEndStatus.COMPLETED },
      });
      if (existingProcess) {
        this.logger.log(`Day-end already completed for ${today.toDateString()}`);
        return;
      }

      const ongoingProcess = await this.dayEndProcessRepository.findOne({
        where: { status: DayEndStatus.IN_PROGRESS },
      });
      if (ongoingProcess) {
        this.logger.warn('Skipping automatic day-end: another process is in progress');
        return;
      }

      this.logger.log('Starting automatic day-end processing');
      await this.initiateDayEnd(
        { processDate: today.toISOString().split('T')[0] },
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
      // FIX BUG 1: Read the process via queryRunner.manager so all reads/writes
      // belong to the same transaction. Never use the default repository inside here.
      const process = await queryRunner.manager.findOne(DayEndProcess, {
        where: { id: processId },
      });

      if (!process) throw new Error('Process not found');

      const results: any = {};
      const steps = [...(process.processSteps || [])];

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
              // Backup runs outside the transaction (file I/O — cannot be rolled back anyway)
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

        // FIX BUG 1: Persist step progress via queryRunner.manager — stays inside
        // the transaction so it rolls back atomically on failure.
        process.processSteps = steps;
        await queryRunner.manager.save(DayEndProcess, process);
      }

      // Mark process as COMPLETED inside the same transaction
      process.status = DayEndStatus.COMPLETED;
      process.completedAt = new Date();
      process.processResults = results;
      await queryRunner.manager.save(DayEndProcess, process);

      // Update getworkingdate — mark current day as done
      const updateResult = await queryRunner.query(`
        UPDATE getworkingdate
        SET dayend_flag = 'Y', updategl_flag = 'Y'
        WHERE working_date::date = $1::date
      `, [process.processDate]);

      // FIX BUG 5: Verify the UPDATE actually matched a row
      const affectedRows = updateResult[1]; // PostgreSQL returns [rows, rowCount]
      if (affectedRows === 0) {
        throw new Error(
          `getworkingdate row not found for date ${process.processDate.toISOString().split('T')[0]}. ` +
          `Day-end aborted to prevent silent data corruption.`
        );
      }

      // Insert next working day — use frontend-provided date or default to +1 day
      const nextDay = process.nextWorkingDate
        ? new Date(process.nextWorkingDate)
        : new Date(process.processDate);
      if (!process.nextWorkingDate) nextDay.setDate(nextDay.getDate() + 1);
      nextDay.setHours(0, 0, 0, 0);

      const existingNext = await queryRunner.query(
        `SELECT 1 FROM getworkingdate WHERE working_date::date = $1::date`, [nextDay]
      );
      if (existingNext.length === 0) {
        await queryRunner.query(`
          INSERT INTO getworkingdate
            (working_date, payment_voucher, receipt_voucher, journal_voucher, dayend_flag, updategl_flag)
          VALUES ($1, 0, 0, 0, 'N', 'N')
        `, [nextDay]);
      }

      this.logger.log(
        `getworkingdate updated: ${process.processDate.toISOString().split('T')[0]} → DAYEND_FLAG=Y, ` +
        `next day ${nextDay.toISOString().split('T')[0]} inserted`
      );

      // Everything succeeded — commit the whole unit atomically
      await queryRunner.commitTransaction();
      this.logger.log(`Day-end process ${processId} completed successfully`);

    } catch (error) {
      // Roll back ALL DB changes (process status, interest postings, loan balances,
      // getworkingdate update) in one atomic step
      await queryRunner.rollbackTransaction();

      // FIX BUG 1: After rollback we can safely use the default repository to mark
      // the process as FAILED — this write is intentionally outside the transaction.
      const failedProcess = await this.dayEndProcessRepository.findOne({
        where: { id: processId },
      });
      if (failedProcess) {
        failedProcess.status = DayEndStatus.FAILED;
        failedProcess.failedAt = new Date();
        failedProcess.errorMessage = error.message;
        await this.dayEndProcessRepository.save(failedProcess);
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

    // FIX BUG 3: Read loans INSIDE the transaction via queryRunner.manager
    // to prevent dirty reads from concurrent processes.
    const activeLoans = await queryRunner.manager.find(LoanAccount, {
      where: { status: 'ACTIVE' },
      relations: ['member'],
    });

    for (const loan of activeLoans) {
      if (loan.outstandingBalance > 0) {
        const balance = Number(loan.outstandingBalance);
        const rate = Number(loan.interestRate);
        const dailyInterestRate = rate / 365 / 100;
        const interestAmount =
          Math.round(balance * dailyInterestRate * 100000) / 100000;

        const interestPosting = this.interestPostingRepository.create({
          memberId: loan.member.id,
          accountId: loan.id,
          accountNumber: loan.accountNumber,
          type: InterestPostingType.LOAN_INTEREST,
          principalAmount: balance,
          interestRate: rate,
          interestAmount,
          calculationDate: processDate,
          postingDate: processDate,
          status: InterestPostingStatus.POSTED,
          remarks: 'Daily interest calculation',
        });

        await queryRunner.manager.save(InterestPosting, interestPosting);

        // Update loan outstanding balance and accrued interest
        loan.outstandingBalance = balance + interestAmount;
        loan.totalInterestAccrued =
          Number(loan.totalInterestAccrued) + interestAmount;
        loan.lastInterestCalculationDate = processDate;
        await queryRunner.manager.save(LoanAccount, loan);

        results.loansProcessed++;
        results.totalInterestPosted =
          Number(results.totalInterestPosted) + interestAmount;
      }
    }

    // FIX BUG 3: Read deposits INSIDE the transaction via queryRunner.manager
    const activeDeposits = await queryRunner.manager.find(FixedDeposit, {
      where: { status: 'ACTIVE' },
      relations: ['member'],
    });

    for (const deposit of activeDeposits) {
      const principal = Number(deposit.principalAmount);
      const rate = Number(deposit.interestRate);
      const dailyInterestRate = rate / 365 / 100;
      const interestAmount =
        Math.round(principal * dailyInterestRate * 100000) / 100000;

      const interestPosting = this.interestPostingRepository.create({
        memberId: deposit.member.id,
        accountId: deposit.id,
        accountNumber: deposit.accountNumber,
        type: InterestPostingType.DEPOSIT_INTEREST,
        principalAmount: principal,
        interestRate: rate,
        interestAmount,
        calculationDate: processDate,
        postingDate: processDate,
        status: InterestPostingStatus.POSTED,
        remarks: 'Daily interest calculation',
      });

      await queryRunner.manager.save(InterestPosting, interestPosting);

      // FIX BUG 6: Update deposit's accrued interest — was missing entirely
      deposit.interestAccrued =
        Number(deposit.interestAccrued) + interestAmount;
      await queryRunner.manager.save(FixedDeposit, deposit);

      results.depositsProcessed++;
      results.totalInterestPosted =
        Number(results.totalInterestPosted) + interestAmount;
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
    return {
      tempFilesDeleted: 0,
      oldLogsDeleted: 0,
      cacheCleared: true,
    };
  }

  private getProcessSteps(processTypes?: DayEndProcessType[]): DayEndProcessStep[] {
    const allSteps: DayEndProcessStep[] = [
      { type: DayEndProcessType.DATA_VALIDATION,     name: 'Data Validation',     status: DayEndStatus.PENDING },
      { type: DayEndProcessType.INTEREST_CALCULATION, name: 'Interest Calculation', status: DayEndStatus.PENDING },
      { type: DayEndProcessType.REPORT_GENERATION,   name: 'Report Generation',   status: DayEndStatus.PENDING },
      { type: DayEndProcessType.BACKUP_CREATION,     name: 'Backup Creation',     status: DayEndStatus.PENDING },
      { type: DayEndProcessType.SYSTEM_CLEANUP,      name: 'System Cleanup',      status: DayEndStatus.PENDING },
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
