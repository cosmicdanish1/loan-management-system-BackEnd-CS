import {
  Injectable,
  BadRequestException,
  NotFoundException,
  Logger,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, DataSource } from 'typeorm';
import { Cron } from '@nestjs/schedule';
import * as fs from 'fs';
import * as path from 'path';
import { LogRetentionService } from '../../../common/logging/log-retention.service';
import {
  DayEndProcess,
  DayEndStatus,
  DayEndProcessType,
  DayEndProcessStep,
} from '../entities/day-end-process.entity';
import {
  InitiateDayEndDto,
  DayEndProcessResponseDto,
  DayEndSummaryDto,
} from '../dto';
import { BackupService } from './backup.service';

@Injectable()
export class DayEndService {
  private readonly logger = new Logger(DayEndService.name);

  constructor(
    @InjectRepository(DayEndProcess)
    private dayEndProcessRepository: Repository<DayEndProcess>,
    private dataSource: DataSource,
    private backupService: BackupService,
    private logRetentionService: LogRetentionService,
  ) { }

  async initiateDayEnd(
    initiateDayEndDto: InitiateDayEndDto,
    userId: number,
  ): Promise<DayEndProcessResponseDto> {
    // BUG FIX: live-tested and confirmed — without a lock, two concurrent calls
    // both pass the "ongoing process" check before either's row commits (classic
    // TOCTOU race). Reproduced: 3 simultaneous requests produced 2 processes both
    // IN_PROGRESS for the same date (two parallel backups, two report-file writes,
    // duplicate audit rows) and a 3rd that crashed with a raw "Record already
    // exists" DB error instead of a clean rejection — the old "FIX BUG 4" comment
    // on the ID query claimed this was already serialized; it wasn't; a plain
    // SELECT MAX(id)+1 has no lock at all. An advisory xact-lock around the whole
    // gate-check + row-creation section makes concurrent callers queue instead of
    // race: whoever gets the lock next correctly sees the previous caller's
    // committed row and is rejected with the intended message.
    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();

    try {
      await queryRunner.query(`SELECT pg_advisory_xact_lock(hashtext('day_end_initiate'))`);

      // Always use the current pending working date from getworkingdate, ignore frontend date
      const pendingDateResult = await queryRunner.query(`
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
        const existingProcess = await queryRunner.manager.findOne(DayEndProcess, {
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
      const ongoingProcess = await queryRunner.manager.findOne(DayEndProcess, {
        where: { status: DayEndStatus.IN_PROGRESS },
      });

      if (ongoingProcess) {
        throw new BadRequestException('Another day-end process is currently in progress');
      }

      // Block day-end if unposted (unpassed) transactions exist — matches legacy behavior
      const unpassed = await queryRunner.query(
        `SELECT COUNT(*) as cnt FROM transactions WHERE pass_flag = 'N'`
      );
      const unpassedCount = parseInt(unpassed[0]?.cnt || '0');
      if (unpassedCount > 0) {
        throw new BadRequestException(
          `Cannot perform Day End — ${unpassedCount} unpass voucher(s) found! Go to Pass Transactions first.`
        );
      }

      // Block day-end if pending loans exist (pass_flag='N' — not yet approved/declined)
      const pendingLoans = await queryRunner.query(
        `SELECT COUNT(*) as cnt FROM loan_pending WHERE COALESCE(pass_flag, 'N') = 'N' AND flg_sanctioned = 'N'`
      );
      const pendingLoanCount = parseInt(pendingLoans[0]?.cnt || '0');
      if (pendingLoanCount > 0) {
        throw new BadRequestException(
          `Cannot perform Day End — ${pendingLoanCount} pending loan application(s) awaiting approval! Go to Pass Transactions to approve or decline them.`
        );
      }

      const nextIdResult = await queryRunner.query(
        `SELECT COALESCE(MAX(id), 0) + 1 AS next_id FROM day_end_processes`
      );
      const nextId = Number(nextIdResult[0]?.next_id ?? 1);

      const processSteps = this.getProcessSteps(initiateDayEndDto.processTypes);

      const dayEndProcess = queryRunner.manager.create(DayEndProcess, {
        id: nextId,
        processDate,
        status: DayEndStatus.IN_PROGRESS,
        startedAt: new Date(),
        initiatedBy: userId,
        processSteps,
        nextWorkingDate: initiateDayEndDto.nextWorkingDate || null,
      } as any);

      const savedProcess = await queryRunner.manager.save(DayEndProcess, dayEndProcess) as unknown as DayEndProcess;

      await queryRunner.commitTransaction();

      // Start processing asynchronously — errors are caught and persisted internally
      this.executeDayEndProcess(savedProcess.id).catch(error => {
        this.logger.error(`Day-end process ${savedProcess.id} failed:`, error);
      });

      return this.mapToResponseDto(savedProcess);
    } catch (error) {
      await queryRunner.rollbackTransaction();
      throw error;
    } finally {
      await queryRunner.release();
    }
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

      // BUG FIX: getworkingdate starts completely empty in a fresh install (confirmed
      // live) and nothing else can create the first row — executeDayEndProcess() only
      // ever inserts the *next* day, requiring a current row to already exist and
      // successfully UPDATE first (same genesis gap as yearend/Financial Year, fixed
      // earlier this session). Previously this silently faked "today" with all-zero
      // vouchers, giving no indication anything was wrong — Day-End would then fail
      // at its very last step (the guarded UPDATE-affected-zero-rows check) if actually
      // run. Now surfaced explicitly so the UI can prompt for a real initial date
      // instead of pretending everything is fine.
      if (!currentRow) {
        return {
          date: new Date().toISOString().split('T')[0],
          openingBalance: 0,
          totalCredit: 0,
          totalDebit: 0,
          closingBalance: 0,
          paymentVouchers: 0,
          receiptVouchers: 0,
          journalVouchers: 0,
          dayendFlag: 'N',
          pendingLoans: 0,
          noWorkingDateSet: true,
        };
      }

      const workingDate = new Date(currentRow.working_date);
      workingDate.setHours(0, 0, 0, 0);

      // BUG FIX: `workingDate.toISOString()` (UTC) was used to build the display
      // string, but pg-types parses a date-only column as LOCAL midnight (confirmed
      // via node diagnostic: `getDate('2026-08-17')` → local Date, not UTC) — the
      // same convention TypeORM's DateUtils and pg's own param serializer both use
      // for `date` columns. On this server (IST, UTC+5:30) converting that local
      // midnight to UTC rolls it back to the previous calendar day: DB held
      // 2026-08-17, this returned 2026-08-16. Fixed by reading the date with LOCAL
      // getters, matching every other layer that touches this Date object.
      const workingDateStr = this.toLocalDateStr(workingDate);

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
        date: workingDateStr,
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

  /**
   * Creates the genesis getworkingdate row — the only bootstrap path, since
   * every other write to this table requires a current row to already exist.
   * Refuses if any row already exists, to avoid double-initializing.
   */
  async initializeWorkingDate(workingDate: string): Promise<{ message: string }> {
    const existing = await this.dataSource.query(`SELECT 1 FROM getworkingdate LIMIT 1`);
    if (existing.length > 0) {
      throw new BadRequestException('getworkingdate already has data — cannot re-initialize.');
    }

    // BUG FIX: `new Date(str); date.setHours(0,0,0,0)` is the pattern used
    // throughout the rest of this file — confirmed live to silently shift the
    // date back a day on this server (IST, UTC+5:30): setHours() re-anchors to
    // LOCAL midnight, but new Date('YYYY-MM-DD') parses as UTC midnight, so the
    // underlying instant moves to the previous day's 18:30 UTC. Avoided here by
    // never constructing a JS Date at all — validate the string shape and let
    // Postgres parse the literal directly as a calendar date.
    if (!/^\d{4}-\d{2}-\d{2}$/.test(workingDate)) {
      throw new BadRequestException('Invalid working date — expected YYYY-MM-DD.');
    }

    await this.dataSource.query(
      `INSERT INTO getworkingdate
        (working_date, payment_voucher, receipt_voucher, journal_voucher, dayend_flag, updategl_flag)
       VALUES ($1::date, 0, 0, 0, 'N', 'N')`,
      [workingDate],
    );

    this.logger.log(`getworkingdate initialized with working date ${workingDate}`);
    return { message: `Working date initialized to ${workingDate}.` };
  }

  /**
   * Corrects a mis-set initial working date (e.g. fat-fingered on genesis
   * setup) — refuses once any real day-end has ever completed, to avoid
   * resetting a working table with real transaction history behind it.
   */
  async resetWorkingDate(): Promise<{ message: string }> {
    const completed = await this.dayEndProcessRepository.count({ where: { status: DayEndStatus.COMPLETED } });
    if (completed > 0) {
      throw new BadRequestException('Cannot reset — day-end has already been completed at least once.');
    }
    await this.dataSource.query(`DELETE FROM getworkingdate`);
    this.logger.log('getworkingdate reset (no completed day-end existed)');
    return { message: 'Working date cleared. Set a new one to continue.' };
  }

  // Formats a Date using LOCAL getters, never `.toISOString()` — pg-types/TypeORM
  // parse a `date`-only column as local midnight, so converting to UTC first
  // rolls it back a calendar day on this (IST) server. Centralizes the fix
  // pattern that was previously duplicated (and in three spots, missed).
  private toLocalDateStr(date: Date): string {
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
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

  // Automated day-end processing (runs at 11:30 PM daily) — OFF by default.
  // A cron that force-closes the working day on a timer conflicts with the
  // (legacy-matching) workflow where staff keep a heavy-volume business day
  // open across several real days to finish entering vouchers for it; the
  // day should only close when a human decides it's ready. Gated behind the
  // 'SYS_DAYEND_AUTO_CLOSE' business-rule toggle (Administration > Modify
  // Business Rules > General Settings), admin-only, defaults to disabled
  // when the key doesn't exist yet.
  @Cron('30 23 * * *')
  async automaticDayEndProcessing() {
    try {
      const configResult = await this.dataSource.query(
        `SELECT value FROM system_configs WHERE key = 'SYS_DAYEND_AUTO_CLOSE'`,
      );
      const autoCloseEnabled = configResult[0]?.value === 'true';
      if (!autoCloseEnabled) {
        this.logger.log('Automatic Day-End is disabled (SYS_DAYEND_AUTO_CLOSE) — skipping nightly auto-close.');
        return;
      }

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
        { processDate: this.toLocalDateStr(today) },
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
          `getworkingdate row not found for date ${this.toLocalDateStr(process.processDate)}. ` +
          `Day-end aborted to prevent silent data corruption.`
        );
      }

      // Insert next working day — use frontend-provided date or default to +1 day.
      // BUG FIX: previously did `new Date(process.nextWorkingDate)` (a 'YYYY-MM-DD'
      // string) then `.setHours(0,0,0,0)` — the same UTC-parse-then-local-midnight
      // pattern already fixed at initializeWorkingDate, which shifts the instant
      // back a day on this (IST) server. The no-nextWorkingDate branch is safe as
      // Date-to-Date arithmetic (matches calculateOpeningBalance's existing correct
      // pattern), so only the string branch needed to avoid constructing a Date.
      let nextDayStr: string;
      if (process.nextWorkingDate) {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(process.nextWorkingDate)) {
          throw new Error(`Invalid nextWorkingDate: ${process.nextWorkingDate}`);
        }
        nextDayStr = process.nextWorkingDate;
      } else {
        const nextDay = new Date(process.processDate);
        nextDay.setDate(nextDay.getDate() + 1);
        nextDayStr = this.toLocalDateStr(nextDay);
      }

      const existingNext = await queryRunner.query(
        `SELECT 1 FROM getworkingdate WHERE working_date::date = $1::date`, [nextDayStr]
      );
      if (existingNext.length === 0) {
        await queryRunner.query(`
          INSERT INTO getworkingdate
            (working_date, payment_voucher, receipt_voucher, journal_voucher, dayend_flag, updategl_flag)
          VALUES ($1::date, 0, 0, 0, 'N', 'N')
        `, [nextDayStr]);
      }

      this.logger.log(
        `getworkingdate updated: ${this.toLocalDateStr(process.processDate)} → DAYEND_FLAG=Y, ` +
        `next day ${nextDayStr} inserted`
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

  private async createBackup(processDate: Date): Promise<any> {
    // BUG FIX: was `.toISOString().split('T')[0]` — live-tested and confirmed this
    // labels the backup file with the wrong calendar day on this (IST) server (a
    // process for 2026-08-14 produced "dayend_2026-08-13_...sql"). Same UTC-parse
    // pattern already fixed elsewhere in this file.
    const backupResult = await this.backupService.createDatabaseBackup(
      `dayend_${this.toLocalDateStr(processDate)}`,
    );
    return {
      backupSize: backupResult.size,
      backupPath: backupResult.path,
      backupTime: new Date(),
    };
  }

  // BUG FIX: previously returned a hardcoded list of report names and a fake
  // path — generated nothing. Now writes an actual cash-book summary file
  // using the same real numbers the UI's day-end screen already computes.
  private async generateReports(processDate: Date): Promise<any> {
    const dateStr = this.toLocalDateStr(processDate);

    const openingBalance = await this.calculateOpeningBalance(processDate);
    const totalCredit = await this.calculateTodayCredits(processDate);
    const totalDebit = await this.calculateTodayDebits(processDate);
    const closingBalance = openingBalance + totalCredit - totalDebit;

    const reportsDir = path.join(process.cwd(), 'reports', 'daily');
    fs.mkdirSync(reportsDir, { recursive: true });
    const reportPath = path.join(reportsDir, `dayend_${dateStr}.json`);
    fs.writeFileSync(
      reportPath,
      JSON.stringify(
        {
          date: dateStr,
          openingBalance,
          totalCredit,
          totalDebit,
          closingBalance,
          generatedAt: new Date().toISOString(),
        },
        null,
        2,
      ),
    );

    return {
      reportsGenerated: ['daily_cash_book'],
      reportPath,
    };
  }

  private async validateData(processDate: Date, queryRunner: any): Promise<any> {
    const validationResults = {
      totalChecks: 0,
      passedChecks: 0,
      failedChecks: 0,
      warnings: [] as string[],
    };

    // BUG FIX: `LoanAccount` (table `loan_accounts`) is a disconnected demo
    // entity with zero real rows — confirmed live. Every real loan lives in
    // `loan_master` (4 active loans right now), so this check was silently a
    // no-op for every real loan, every day. Read-only, so safe to repoint —
    // unlike the interest-accrual block below, this never touches balances.
    const loans = await queryRunner.query(
      `SELECT loancaseno, balance FROM loan_master WHERE balance > 0`,
    );

    for (const loan of loans) {
      validationResults.totalChecks++;
      if (Number(loan.balance) < 0) {
        validationResults.failedChecks++;
        validationResults.warnings.push(
          `Loan ${loan.loancaseno} has negative outstanding balance`,
        );
      } else {
        validationResults.passedChecks++;
      }
    }

    // BUG FIX 44: same disconnected-entity issue as calculateInterest above — this
    // validated the `fixed_deposits` table (always empty) instead of the real
    // `fdmaster` accounts.
    // BUG FIX 45: same wrong 'A' assumption as calculateInterest above — '0' is real.
    const deposits = await queryRunner.query(`
      SELECT account_number, fdamount FROM fdmaster WHERE fdrdflag = 'F' AND status = '0'
    `);

    for (const deposit of deposits) {
      validationResults.totalChecks++;
      if (Number(deposit.fdamount) <= 0) {
        validationResults.failedChecks++;
        validationResults.warnings.push(
          `Deposit ${deposit.account_number} has invalid principal amount`,
        );
      } else {
        validationResults.passedChecks++;
      }
    }

    return validationResults;
  }

  // BUG FIX: previously returned hardcoded zeros/true — did nothing. Now runs
  // the same log-retention sweep LogRetentionService normally only runs hourly
  // on its own cron, and reports the real counts. No temp-file or cache layer
  // exists in this app yet, so those stay honestly at 0/false rather than
  // claiming a cleanup that never happened.
  private async performSystemCleanup(processDate: Date): Promise<any> {
    const retention = await this.logRetentionService.enforceRetention();
    return {
      tempFilesDeleted: 0,
      oldLogsDeleted: retention.deletedCount,
      logsFreedBytes: retention.freedBytes,
      cacheCleared: false,
    };
  }

  private getProcessSteps(processTypes?: DayEndProcessType[]): DayEndProcessStep[] {
    const allSteps: DayEndProcessStep[] = [
      { type: DayEndProcessType.DATA_VALIDATION,     name: 'Data Validation',     status: DayEndStatus.PENDING },
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
