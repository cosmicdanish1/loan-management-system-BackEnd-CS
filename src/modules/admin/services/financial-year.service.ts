import { Injectable, NotFoundException, BadRequestException, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, DataSource } from 'typeorm';
import { FinancialYear } from '../entities/financial-year.entity';
import { isDebitNormal } from '../../shared/utils/balance-direction';

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
                    AND l.trans_date >= $1 AND l.trans_date <= $2
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
                }
                if (md !== 0) {
                    await queryRunner.query(
                        `INSERT INTO yearend_member (yearcode, acc_type, mbno, balance) VALUES ($1, 'MD', $2, ROUND($3::numeric, 2))`,
                        [yearCode, row.mbno, md]
                    );
                }
                if (shr !== 0) {
                    await queryRunner.query(
                        `INSERT INTO yearend_member (yearcode, acc_type, mbno, balance) VALUES ($1, 'SHR', $2, ROUND($3::numeric, 2))`,
                        [yearCode, row.mbno, shr]
                    );
                }
            }

            // Also populate bankopbal for backward compatibility
            await queryRunner.query(`DELETE FROM bankopbal WHERE fycode = $1`, [yearCode]);
            await queryRunner.query(`
                INSERT INTO bankopbal (trfid, fycode, headcode, parentcode, closingbalance)
                SELECT ROW_NUMBER() OVER (ORDER BY head_code), $1, head_code, parent_code, closing_bal
                FROM yearend_head WHERE yearcode = $1
            `, [yearCode]);

            await queryRunner.commitTransaction();

            const headCount = headBalances.length;
            const memberCount = loanBalances.length + fundBalances.length;
            this.logger.log(`Year-end transfer complete: ${headCount} heads, ${memberCount} member entries archived`);

            return {
                message: `Year-end transfer for FY ${yearCode} completed. Archived ${headCount} head balances and ${memberCount} member balances.`
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

            const maxResult = await queryRunner.query(`SELECT COALESCE(MAX(trans_no::bigint), 0) + 1 as next FROM ledger`);
            let nextNo = parseInt(maxResult[0]?.next || '1');

            await queryRunner.query(`
                INSERT INTO ledger (trans_no, trans_date, trans_type, code, mbno, acc_no, acc_type, trans_amt, receipt_vchr_no, vchr_type, modeofpay, pl_balance, narration, username)
                VALUES ($1, $2, 'DR', $3, 0, 0, 'OTH', $4, '', 'JV', 'T', 0, $5, $6)
            `, [nextNo, transferDate || new Date(), fromAccount, amount, description || 'Balance Transfer', username]);

            await queryRunner.query(`
                INSERT INTO ledger (trans_no, trans_date, trans_type, code, mbno, acc_no, acc_type, trans_amt, receipt_vchr_no, vchr_type, modeofpay, pl_balance, narration, username)
                VALUES ($1, $2, 'CR', $3, 0, 0, 'OTH', $4, '', 'JV', 'T', 0, $5, $6)
            `, [nextNo + 1, transferDate || new Date(), toAccount, amount, description || 'Balance Transfer', username]);

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
            const profitResult = await queryRunner.query(`
                SELECT
                    COALESCE(SUM(CASE WHEN hm.pflag = 'I' THEN yh.closing_bal ELSE 0 END), 0) as total_income,
                    COALESCE(SUM(CASE WHEN hm.pflag = 'E' THEN yh.closing_bal ELSE 0 END), 0) as total_expense
                FROM yearend_head yh
                JOIN headmaster hm ON hm.code = yh.head_code
                WHERE yh.yearcode = $1
            `, [yearCode]);

            const totalIncome = parseFloat(profitResult[0]?.total_income) || 0;
            const totalExpense = parseFloat(profitResult[0]?.total_expense) || 0;
            const profit = Math.round((totalIncome - totalExpense) * 100) / 100;

            this.logger.log(`FY ${yearCode}: Income=${totalIncome}, Expense=${totalExpense}, Profit=${profit}`);

            // Step 2: Identify Reserve/P&L head (pflag='R', take first)
            const reserveHead = await queryRunner.query(
                `SELECT code FROM headmaster WHERE pflag = 'R' ORDER BY code LIMIT 1`
            );
            const reserveCode = reserveHead[0]?.code;

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

            // Step 5: Zero out Income and Expense heads for new year
            await queryRunner.query(
                `UPDATE headmaster SET op_bal = 0 WHERE pflag IN ('I', 'E')`
            );

            // Step 6: Create new financial year row (dates +1 year)
            const newYearCode = yearCode + 1;
            const existingNewFY = await queryRunner.query(
                `SELECT yearcode FROM yearend WHERE yearcode = $1`, [newYearCode]
            );

            if (existingNewFY.length === 0) {
                const newStart = new Date(currentFY.startDate);
                newStart.setFullYear(newStart.getFullYear() + 1);
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
