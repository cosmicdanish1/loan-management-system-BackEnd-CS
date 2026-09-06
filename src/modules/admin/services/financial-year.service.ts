import { Injectable, NotFoundException, BadRequestException, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, DataSource } from 'typeorm';
import { FinancialYear } from '../entities/financial-year.entity';
import { isDebitNormal } from '../../shared/utils/balance-direction';

// Heads with an Income/Expense pflag that must never participate in the P&L
// Year End profit calculation or the Income/Expense zero-out. Confirmed with
// the user (2026-08-23) after live testing surfaced E1030 "NET PROFIT": a
// pflag='E' head with zero ledger activity ever, whose stale ₹1.40 crore
// balance exactly duplicates the properly-recorded L1044 "NET PROFIT
// F.Y.2018-2019" liability head — a legacy P&L-report formatting artifact,
// not a real transactional expense. Without this exclusion it silently
// swallowed most of the real profit and would have been zeroed with no
// way to recover it.
const PL_YEAR_END_EXCLUDED_HEAD_CODES = ['E1030'];

@Injectable()
export class FinancialYearService {
    private readonly logger = new Logger(FinancialYearService.name);

    constructor(
        @InjectRepository(FinancialYear)
        private financialYearRepository: Repository<FinancialYear>,
        private dataSource: DataSource,
    ) { }

    async getFinancialYears(): Promise<FinancialYear[]> {
        return this.financialYearRepository.find({
            order: { yearCode: 'DESC' },
        });
    }

    /**
     * Creates a financial year. `yearend` starts out completely empty in a
     * fresh install and nothing else in the app can create the first row —
     * performPLYearEndProcess only ever derives the *next* year's dates from
     * an *existing* current year, so there was no bootstrap path at all.
     * This is that path, for both genesis and any later gap-year creation.
     */
    async createFinancialYear(startDate: string, endDate: string, username: string): Promise<FinancialYear> {
        const start = new Date(startDate);
        const end = new Date(endDate);

        if (isNaN(start.getTime()) || isNaN(end.getTime())) {
            throw new BadRequestException('Start date and end date must be valid dates.');
        }
        if (start >= end) {
            throw new BadRequestException('Start date must be before end date.');
        }

        // Guard against overlapping an existing year — this table isn't append-only
        // by date, so a bad genesis entry would otherwise silently double-book a period.
        const overlapping = await this.financialYearRepository
            .createQueryBuilder('fy')
            .where('fy.startDate <= :end AND fy.endDate >= :start', { start, end })
            .getOne();
        if (overlapping) {
            throw new BadRequestException(
                `The selected period overlaps with existing Financial Year ${overlapping.yearCode} ` +
                `(${overlapping.startDate.toISOString().slice(0, 10)} to ${overlapping.endDate.toISOString().slice(0, 10)}).`,
            );
        }

        const lastYear = await this.financialYearRepository.find({ order: { yearCode: 'DESC' }, take: 1 });
        const nextYearCode = lastYear.length > 0 ? lastYear[0].yearCode + 1 : 1;

        const fy = this.financialYearRepository.create({
            yearCode: nextYearCode,
            startDate: start,
            endDate: end,
            username,
        });
        const saved = await this.financialYearRepository.save(fy);

        this.logger.log(`Financial Year ${nextYearCode} created (${startDate} to ${endDate}) by ${username}`);
        return saved;
    }

    /**
     * Admin cleanup for a mistakenly-created year — refuses if closed (never
     * force-able, closing is meant to be final). If Transfer Entries has
     * already archived into it, refuses unless `force` is set, in which case
     * the archive tables (yearend_head/yearend_member/bankopbal) are cleared
     * too — a legitimate "redo transfer entries from scratch" path, not just
     * a one-off escape hatch.
     */
    async deleteFinancialYear(yearCode: number, force = false): Promise<{ message: string }> {
        const fy = await this.getFinancialYear(yearCode);

        if (fy.closedAt) {
            throw new BadRequestException(`Financial Year ${yearCode} is closed and cannot be deleted.`);
        }

        const archived = await this.dataSource.query(
            `SELECT COUNT(*) as cnt FROM yearend_head WHERE yearcode = $1`, [yearCode]
        );
        const hasArchive = parseInt(archived[0]?.cnt || '0') > 0;
        if (hasArchive && !force) {
            throw new BadRequestException(`Financial Year ${yearCode} already has archived closing entries. Pass force=true to delete anyway.`);
        }

        if (hasArchive) {
            await this.dataSource.query(`DELETE FROM yearend_head WHERE yearcode = $1`, [yearCode]);
            await this.dataSource.query(`DELETE FROM yearend_member WHERE yearcode = $1`, [yearCode]);
            await this.dataSource.query(`DELETE FROM bankopbal WHERE fycode = $1`, [yearCode]);
        }

        await this.financialYearRepository.delete({ yearCode });
        return { message: `Financial Year ${yearCode} deleted.` };
    }

    async getFinancialYear(yearCode: number): Promise<FinancialYear> {
        const fy = await this.financialYearRepository.findOne({
            where: { yearCode },
        });

        if (!fy) {
            throw new NotFoundException(`Financial Year with code '${yearCode}' not found`);
        }

        return fy;
    }

    async getCurrentFinancialYear(): Promise<FinancialYear | null> {
        const now = new Date();
        return this.financialYearRepository.createQueryBuilder('fy')
            .where('fy.startDate <= :now AND fy.endDate >= :now', { now })
            .getOne();
    }

    /**
     * F6: Archive all head and member balances to yearend_head / yearend_member
     * Must run BEFORE performPLYearEndProcess (F7)
     */
    async initiateTransfer(yearCode: number, username: string): Promise<{ message: string }> {
        const fy = await this.getFinancialYear(yearCode);
        this.logger.log(`Initiating year-end transfer for FY ${yearCode} by ${username}`);

        const queryRunner = this.dataSource.createQueryRunner();
        await queryRunner.connect();
        await queryRunner.startTransaction();

        try {
            // Calculate closing balance for each head using pflag-aware direction
            const headBalances = await queryRunner.query(`
                SELECT
                    hm.code as head_code,
                    hm.parent_code,
                    hm.pflag,
                    COALESCE(hm.op_bal, 0) as op_bal,
                    COALESCE(SUM(CASE WHEN l.trans_type = 'DR' THEN l.trans_amt::numeric ELSE 0 END), 0) as total_dr,
                    COALESCE(SUM(CASE WHEN l.trans_type = 'CR' THEN l.trans_amt::numeric ELSE 0 END), 0) as total_cr
                FROM headmaster hm
                LEFT JOIN ledger l ON l.code = hm.code
                    AND l.trans_date >= $1::timestamp AND l.trans_date <= $2::timestamp
                GROUP BY hm.code, hm.parent_code, hm.pflag, hm.op_bal
            `, [fy.startDate, fy.endDate]);

            // Idempotent: clear previous archive for this yearcode
            await queryRunner.query(`DELETE FROM yearend_head WHERE yearcode = $1`, [yearCode]);
            await queryRunner.query(`DELETE FROM yearend_member WHERE yearcode = $1`, [yearCode]);

            // Insert closing balances into yearend_head
            for (const head of headBalances) {
                const opBal = parseFloat(head.op_bal) || 0;
                const dr = parseFloat(head.total_dr) || 0;
                const cr = parseFloat(head.total_cr) || 0;

                let closingBal: number;
                if (isDebitNormal(head.pflag)) {
                    closingBal = opBal + dr - cr;
                } else {
                    closingBal = opBal + cr - dr;
                }

                await queryRunner.query(
                    `INSERT INTO yearend_head (yearcode, head_code, parent_code, closing_bal)
                     VALUES ($1, $2, $3, ROUND($4::numeric, 2))`,
                    [yearCode, head.head_code, head.parent_code, closingBal]
                );
            }

            let memberEntriesWritten = 0;

            // Archive member balances from loan_master (grouped by loantype)
            const loanBalances = await queryRunner.query(`
                SELECT loantype as acc_type, mbno::text as mbno, SUM(balance) as balance
                FROM loan_master WHERE balance > 0
                GROUP BY loantype, mbno
            `);

            for (const row of loanBalances) {
                await queryRunner.query(
                    `INSERT INTO yearend_member (yearcode, acc_type, mbno, balance)
                     VALUES ($1, $2, $3, ROUND($4::numeric, 2))`,
                    [yearCode, row.acc_type, row.mbno, parseFloat(row.balance) || 0]
                );
                memberEntriesWritten++;
            }

            // Archive member fund balances (CD, MD, Share)
            const fundBalances = await queryRunner.query(`
                SELECT mbno::text,
                    COALESCE(cdopbal, 0) + COALESCE(cdamt, 0) as cd_bal,
                    COALESCE(mdopbal, 0) + COALESCE(mdamt, 0) as md_bal,
                    COALESCE(shareopbal, 0) + COALESCE(shareamt, 0) as shr_bal
                FROM fundsmaster
            `);

            for (const row of fundBalances) {
                const cd = parseFloat(row.cd_bal) || 0;
                const md = parseFloat(row.md_bal) || 0;
                const shr = parseFloat(row.shr_bal) || 0;

                if (cd !== 0) {
                    await queryRunner.query(
                        `INSERT INTO yearend_member (yearcode, acc_type, mbno, balance) VALUES ($1, 'CD', $2, ROUND($3::numeric, 2))`,
                        [yearCode, row.mbno, cd]
                    );
                    memberEntriesWritten++;
                }
                if (md !== 0) {
                    await queryRunner.query(
                        `INSERT INTO yearend_member (yearcode, acc_type, mbno, balance) VALUES ($1, 'MD', $2, ROUND($3::numeric, 2))`,
                        [yearCode, row.mbno, md]
                    );
                    memberEntriesWritten++;
                }
                if (shr !== 0) {
                    await queryRunner.query(
                        `INSERT INTO yearend_member (yearcode, acc_type, mbno, balance) VALUES ($1, 'SHR', $2, ROUND($3::numeric, 2))`,
                        [yearCode, row.mbno, shr]
                    );
                    memberEntriesWritten++;
                }
            }

            // Archive member savings (SB) balances — one member can hold several
            // sbmaster accounts, so aggregate to a single per-member balance like
            // the loan/fund archives above. Was previously omitted entirely: the
            // year-end snapshot silently excluded a whole account category.
            const sbBalances = await queryRunner.query(`
                SELECT mbno::text, SUM(balance) as sb_bal
                FROM sbmaster
                GROUP BY mbno
                HAVING SUM(balance) <> 0
            `);

            for (const row of sbBalances) {
                await queryRunner.query(
                    `INSERT INTO yearend_member (yearcode, acc_type, mbno, balance) VALUES ($1, 'SB', $2, ROUND($3::numeric, 2))`,
                    [yearCode, row.mbno, parseFloat(row.sb_bal) || 0]
                );
                memberEntriesWritten++;
            }

            // Also populate bankopbal for backward compatibility
            await queryRunner.query(`DELETE FROM bankopbal WHERE fycode = $1`, [yearCode]);
            // BUG FIX: $1 was reused for two columns of different types
            // (bankopbal.fycode is integer, yearend_head.yearcode is numeric) —
            // Postgres can't deduce one consistent type for a single placeholder
            // used both ways, so this always failed ("inconsistent types deduced
            // for parameter $1"). Confirmed live — this was never reachable
            // before now since yearend had zero rows until this session.
            //
            // BUG FIX: trfid has no uniqueness constraint and ROW_NUMBER() always
            // restarted at 1, so a second year's transfer would mint trfid values
            // that collide with the first year's rows already sitting in the same
            // table. Offset by the current MAX(trfid) (advisory-locked against a
            // concurrent transfer, same pattern as the other MAX()+1 sites) so
            // every row gets a table-wide-unique id.
            await queryRunner.query(`SELECT pg_advisory_xact_lock(hashtext('bankopbal.trfid'))`);
            const trfidBase = await queryRunner.query(`SELECT COALESCE(MAX(trfid), 0) as max FROM bankopbal`);
            const baseTrfid = parseInt(trfidBase[0]?.max || '0');
            await queryRunner.query(`
                INSERT INTO bankopbal (trfid, fycode, headcode, parentcode, closingbalance)
                SELECT ROW_NUMBER() OVER (ORDER BY head_code) + $1, $2, head_code, parent_code, closing_bal
                FROM yearend_head WHERE yearcode = $3
            `, [baseTrfid, yearCode, yearCode]);

            await queryRunner.commitTransaction();

            const headCount = headBalances.length;
            this.logger.log(`Year-end transfer complete: ${headCount} heads, ${memberEntriesWritten} member balance entries archived`);

            return {
                message: `Year-end transfer for FY ${yearCode} completed. Archived ${headCount} head balances and ${memberEntriesWritten} member balances.`
            };
        } catch (error: any) {
            await queryRunner.rollbackTransaction();
            this.logger.error('Year-end transfer failed', error);
            throw new BadRequestException('Year-end transfer failed: ' + error.message);
        } finally {
            await queryRunner.release();
        }
    }

    async performBalanceTransfer(transferData: any, username: string): Promise<{ success: boolean; message: string }> {
        const { fromAccount, toAccount, amount, description, transferDate } = transferData;

        this.logger.log(`Performing balance transfer from ${fromAccount} to ${toAccount} of amount ${amount} by ${username}`);

        const queryRunner = this.dataSource.createQueryRunner();
        await queryRunner.connect();
        await queryRunner.startTransaction();

        try {
            const fromHead = await queryRunner.query(`SELECT code, head_name FROM headmaster WHERE code = $1`, [fromAccount]);
            const toHead = await queryRunner.query(`SELECT code, head_name FROM headmaster WHERE code = $1`, [toAccount]);

            if (fromHead.length === 0) throw new BadRequestException(`Account ${fromAccount} not found`);
            if (toHead.length === 0) throw new BadRequestException(`Account ${toAccount} not found`);

            // BUG FIX: advisory lock guards both id generations below against the
            // same MAX(id)+1 race already tracked as a systemic issue elsewhere
            // (loan/utilities/interest services) — fixed here since this function
            // was being rewritten anyway to fix the ledgerid crash below.
            await queryRunner.query(`SELECT pg_advisory_xact_lock(hashtext('ledger.trans_no_ledgerid'))`);

            const maxResult = await queryRunner.query(`SELECT COALESCE(MAX(trans_no::bigint), 0) + 1 as next FROM ledger`);
            let nextNo = parseInt(maxResult[0]?.next || '1');

            // BUG FIX: ledger.ledgerid is NOT NULL with no default/sequence — this
            // raw INSERT never included it, so every balance transfer crashed
            // ("null value in column ledgerid violates not-null constraint").
            // Confirmed live before this fix.
            const ledgerIdResult = await queryRunner.query(`SELECT COALESCE(MAX(ledgerid), 0) + 1 as next FROM ledger`);
            let nextLedgerId = parseInt(ledgerIdResult[0]?.next || '1');

            await queryRunner.query(`
                INSERT INTO ledger (ledgerid, trans_no, trans_date, trans_type, code, mbno, acc_no, acc_type, trans_amt, receipt_vchr_no, vchr_type, modeofpay, pl_balance, narration, username)
                VALUES ($1, $2, $3, 'DR', $4, 0, 0, 'OTH', $5, '', 'JV', 'T', 0, $6, $7)
            `, [nextLedgerId, nextNo, transferDate || new Date(), fromAccount, amount, description || 'Balance Transfer', username]);

            await queryRunner.query(`
                INSERT INTO ledger (ledgerid, trans_no, trans_date, trans_type, code, mbno, acc_no, acc_type, trans_amt, receipt_vchr_no, vchr_type, modeofpay, pl_balance, narration, username)
                VALUES ($1, $2, $3, 'CR', $4, 0, 0, 'OTH', $5, '', 'JV', 'T', 0, $6, $7)
            `, [nextLedgerId + 1, nextNo + 1, transferDate || new Date(), toAccount, amount, description || 'Balance Transfer', username]);

            await queryRunner.commitTransaction();
            return { success: true, message: `Balance of ${amount} transferred from ${fromAccount} to ${toAccount} successfully.` };
        } catch (error: any) {
            await queryRunner.rollbackTransaction();
            throw new BadRequestException('Balance transfer failed: ' + error.message);
        } finally {
            await queryRunner.release();
        }
    }

    async closeFinancialYear(yearCode: number, username: string): Promise<{ message: string }> {
        const fy = await this.getFinancialYear(yearCode);

        if (fy.closedAt) {
            throw new BadRequestException(`Financial Year ${yearCode} is already closed (closed at ${fy.closedAt.toISOString()}).`);
        }

        await this.financialYearRepository.update(
            { yearCode },
            { closedAt: new Date(), username },
        );

        this.logger.log(`Financial Year ${yearCode} closed by ${username}`);
        return { message: `Financial Year ${yearCode} has been formally closed.` };
    }

    /**
     * Preview of the closing entries F7 would post for a year, sourced from the
     * F6 archive (yearend_head) — read-only, no writes. Powers the P&L Year End
     * Process screen's review table before the user commits to Post.
     */
    async getClosingEntriesPreview(yearCode: number): Promise<{
        rows: { code: string; name: string; pflag: string; closingBal: number }[];
        totalIncome: number;
        totalExpense: number;
        netProfit: number;
        reserveHead: { code: string; name: string } | null;
    }> {
        const rows = await this.dataSource.query(`
            SELECT hm.code, hm.head_name, hm.pflag, yh.closing_bal
            FROM yearend_head yh
            JOIN headmaster hm ON hm.code = yh.head_code
            WHERE yh.yearcode = $1 AND hm.pflag IN ('I', 'E') AND yh.closing_bal <> 0
              AND hm.code <> ALL($2::text[])
            ORDER BY hm.pflag, hm.code
        `, [yearCode, PL_YEAR_END_EXCLUDED_HEAD_CODES]);

        const totals = await this.dataSource.query(`
            SELECT
                COALESCE(SUM(CASE WHEN hm.pflag = 'I' THEN yh.closing_bal ELSE 0 END), 0) as total_income,
                COALESCE(SUM(CASE WHEN hm.pflag = 'E' THEN yh.closing_bal ELSE 0 END), 0) as total_expense
            FROM yearend_head yh
            JOIN headmaster hm ON hm.code = yh.head_code
            WHERE yh.yearcode = $1 AND hm.code <> ALL($2::text[])
        `, [yearCode, PL_YEAR_END_EXCLUDED_HEAD_CODES]);

        // Same reserve head performPLYearEndProcess posts profit to — kept in sync
        // so the preview here never disagrees with what Post actually does.
        const RESERVE_FUND_HEAD_CODE = 'L1006';
        const reserveHead = await this.dataSource.query(
            `SELECT code, head_name FROM headmaster WHERE code = $1`, [RESERVE_FUND_HEAD_CODE]
        );

        const totalIncome = parseFloat(totals[0]?.total_income) || 0;
        const totalExpense = parseFloat(totals[0]?.total_expense) || 0;

        return {
            rows: rows.map((r: any) => ({
                code: r.code,
                name: r.head_name,
                pflag: r.pflag,
                closingBal: parseFloat(r.closing_bal) || 0,
            })),
            totalIncome,
            totalExpense,
            netProfit: Math.round((totalIncome - totalExpense) * 100) / 100,
            reserveHead: reserveHead[0] ? { code: reserveHead[0].code, name: reserveHead[0].head_name } : null,
        };
    }

    /**
     * F7: P&L Year-End — carry forward balances, calculate profit, zero out I/E
     * Prerequisite: initiateTransfer (F6) must have populated yearend_head
     */
    async performPLYearEndProcess(username: string): Promise<{ success: boolean; message: string }> {
        this.logger.log(`Initiating P&L Year End Process by ${username}`);

        const currentFY = await this.getCurrentFinancialYear();
        if (!currentFY) {
            throw new BadRequestException('No active financial year found.');
        }
        const yearCode = currentFY.yearCode;

        // Guard: yearend_head must be populated (F6 prerequisite)
        const archiveCheck = await this.dataSource.query(
            `SELECT COUNT(*) as cnt FROM yearend_head WHERE yearcode = $1`, [yearCode]
        );
        if (parseInt(archiveCheck[0]?.cnt || '0') === 0) {
            throw new BadRequestException(
                'Year-end head balances not found. Run "Transfer Entries for Closing" first before executing P&L Year End.'
            );
        }

        const queryRunner = this.dataSource.createQueryRunner();
        await queryRunner.connect();
        await queryRunner.startTransaction();

        try {
            // Step 1: Calculate Profit = SUM(Income closing) - SUM(Expense closing)
            // Excludes PL_YEAR_END_EXCLUDED_HEAD_CODES (see constant doc) — legacy
            // report-formatting heads with no real transactional activity that must
            // not be mistaken for this year's income/expense.
            const profitResult = await queryRunner.query(`
                SELECT
                    COALESCE(SUM(CASE WHEN hm.pflag = 'I' THEN yh.closing_bal ELSE 0 END), 0) as total_income,
                    COALESCE(SUM(CASE WHEN hm.pflag = 'E' THEN yh.closing_bal ELSE 0 END), 0) as total_expense
                FROM yearend_head yh
                JOIN headmaster hm ON hm.code = yh.head_code
                WHERE yh.yearcode = $1 AND hm.code <> ALL($2::text[])
            `, [yearCode, PL_YEAR_END_EXCLUDED_HEAD_CODES]);

            const totalIncome = parseFloat(profitResult[0]?.total_income) || 0;
            const totalExpense = parseFloat(profitResult[0]?.total_expense) || 0;
            const profit = Math.round((totalIncome - totalExpense) * 100) / 100;

            this.logger.log(`FY ${yearCode}: Income=${totalIncome}, Expense=${totalExpense}, Profit=${profit}`);

            // Step 2: Identify the Reserve Fund head that receives the year's profit.
            // BUG FIX: was `WHERE pflag = 'R' ORDER BY code LIMIT 1` — pflag='R' means
            // "root/group header" in this schema (matches A1000/E1000/I1000/L1000/M1000,
            // the five top-level group nodes), not "Reserve". That picked A1000 (ASSET
            // root) alphabetically and would have posted the whole year's profit onto
            // the asset-side group header. Legacy's own PL2BSAc config table (meant to
            // designate this head) is empty/unconfigured in production, so there's no
            // legacy value to inherit — using the real Reserve Fund head instead.
            const RESERVE_FUND_HEAD_CODE = 'L1006'; // RESERVE FUND
            const reserveHead = await queryRunner.query(
                `SELECT code FROM headmaster WHERE code = $1`, [RESERVE_FUND_HEAD_CODE]
            );
            if (reserveHead.length === 0) {
                throw new BadRequestException(
                    `Reserve Fund head (${RESERVE_FUND_HEAD_CODE}) not found in headmaster. Cannot post year-end profit.`
                );
            }
            const reserveCode = reserveHead[0].code;

            // Step 3: Carry forward A/L/R heads — set op_bal = closing_bal from yearend_head
            await queryRunner.query(`
                UPDATE headmaster hm
                SET op_bal = ROUND(yh.closing_bal::numeric, 2)
                FROM yearend_head yh
                WHERE yh.head_code = hm.code
                  AND yh.yearcode = $1
                  AND hm.pflag IN ('A', 'L', 'R')
            `, [yearCode]);

            // Step 4: Add profit to Reserve head
            if (reserveCode && profit !== 0) {
                await queryRunner.query(
                    `UPDATE headmaster SET op_bal = COALESCE(op_bal, 0) + $1 WHERE code = $2`,
                    [profit, reserveCode]
                );
                this.logger.log(`Added profit ${profit} to reserve head ${reserveCode}`);
            }

            // Step 5: Zero out Income and Expense heads for new year — excluded heads
            // are left untouched, same reasoning as Step 1.
            await queryRunner.query(
                `UPDATE headmaster SET op_bal = 0 WHERE pflag IN ('I', 'E') AND code <> ALL($1::text[])`,
                [PL_YEAR_END_EXCLUDED_HEAD_CODES]
            );

            // Step 6: Create new financial year row (dates +1 year)
            const newYearCode = yearCode + 1;
            const existingNewFY = await queryRunner.query(
                `SELECT yearcode FROM yearend WHERE yearcode = $1`, [newYearCode]
            );

            if (existingNewFY.length === 0) {
                // BUG FIX: was shifting the *current* year's own start/end forward by
                // a year, which only stays gap-free if every FY happens to be exactly
                // 12 months. Legacy's Pr_YearEnd instead derives the new year from the
                // old year's END date (start = end+1 day, end = end+1 year), guaranteeing
                // the new year is always contiguous with no gap or overlap.
                const newStart = new Date(currentFY.endDate);
                newStart.setDate(newStart.getDate() + 1);
                const newEnd = new Date(currentFY.endDate);
                newEnd.setFullYear(newEnd.getFullYear() + 1);

                await queryRunner.query(
                    `INSERT INTO yearend (yearcode, start_date, end_date, username)
                     VALUES ($1, $2, $3, $4)`,
                    [newYearCode, newStart, newEnd, username]
                );
                this.logger.log(`Created new FY ${newYearCode}: ${newStart.toISOString()} to ${newEnd.toISOString()}`);
            }

            // Step 7: Mark current FY as closed
            await queryRunner.query(
                `UPDATE yearend SET closed_at = NOW(), username = $1 WHERE yearcode = $2`,
                [username, yearCode]
            );

            await queryRunner.commitTransaction();

            return {
                success: true,
                message: `P&L Year End completed for FY ${yearCode}. Profit: ${profit}. ` +
                    `Income/Expense heads zeroed. Asset/Liability/Reserve balances carried forward. ` +
                    `New FY ${newYearCode} created.`
            };
        } catch (error: any) {
            await queryRunner.rollbackTransaction();
            this.logger.error('P&L Year End Process failed', error);
            throw new BadRequestException('P&L Year End failed: ' + error.message);
        } finally {
            await queryRunner.release();
        }
    }
}
