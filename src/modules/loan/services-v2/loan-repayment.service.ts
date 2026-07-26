import { Injectable, BadRequestException } from '@nestjs/common';
import { DataSource } from 'typeorm';

export interface RepaymentDto {
    mbno: string;
    loancaseno: string;
    paymentMonth: number;
    paymentYear: number;
    paymentAmount: number;
    receiptNo?: string;
    narration?: string;
    username?: string;
}

@Injectable()
export class LoanRepaymentService {
    constructor(private readonly dataSource: DataSource) {}

    async recordLoanRepayment(dto: RepaymentDto): Promise<{ success: boolean; message: string }> {
        const queryRunner = this.dataSource.createQueryRunner();
        await queryRunner.connect();
        await queryRunner.startTransaction();

        try {
            // 1. Verify loan exists in loan_master and has balance
            const loanRows = await queryRunner.query(
                `SELECT mbno, loantype, loan_amt, balance, instal_amt FROM loan_master WHERE loancaseno::text = $1`,
                [dto.loancaseno]
            );
            if (loanRows.length === 0) {
                throw new BadRequestException(`Loan case ${dto.loancaseno} not found in loan_master`);
            }
            const loan = loanRows[0];
            const currentBalance = parseFloat(loan.balance || 0);
            const payment = parseFloat(dto.paymentAmount as any);

            if (payment <= 0) throw new BadRequestException('Payment amount must be greater than zero');
            if (currentBalance <= 0) throw new BadRequestException(`Loan ${dto.loancaseno} is already fully repaid`);

            const appliedAmount = Math.min(payment, currentBalance);

            // 2. Record in loan_repayment_ledger
            await queryRunner.query(
                `INSERT INTO loan_repayment_ledger
                    (mbno, loancaseno, loantype, payment_date, payment_month, payment_year, payment_amount, receipt_no, narration, posted_by)
                 VALUES ($1, $2, $3, CURRENT_DATE, $4, $5, $6, $7, $8, $9)`,
                [
                    dto.mbno, dto.loancaseno, loan.loantype,
                    dto.paymentMonth, dto.paymentYear,
                    appliedAmount,
                    dto.receiptNo || null,
                    dto.narration || 'Loan Repayment',
                    dto.username || 'system'
                ]
            );

            // 3. Reduce outstanding balance in loan_master
            const newBalance = Math.max(0, currentBalance - appliedAmount);
            await queryRunner.query(
                `UPDATE loan_master SET balance = $1 WHERE loancaseno::text = $2`,
                [newBalance, dto.loancaseno]
            );

            // 4. Reduce balance_for_month in demand_master (mark installment as (partially) paid)
            await queryRunner.query(
                `UPDATE demand_master
                 SET balance_for_month = GREATEST(0, balance_for_month - $1)
                 WHERE mbno = $2 AND demand_for_month = $3 AND demand_for_year = $4`,
                [appliedAmount, dto.mbno, dto.paymentMonth, dto.paymentYear]
            );

            // 5. Reduce member_balances
            const isEmergency = (loan.loantype === 'ELN' || (loan.loantype || '').toUpperCase().includes('EMERGENCY'));
            if (isEmergency) {
                await queryRunner.query(
                    `UPDATE member_balances SET emergency_loan_balance = GREATEST(0, COALESCE(emergency_loan_balance, 0) - $1) WHERE mbno = $2`,
                    [appliedAmount, dto.mbno]
                );
            } else {
                await queryRunner.query(
                    `UPDATE member_balances SET regularloan = GREATEST(0, COALESCE(regularloan, 0) - $1) WHERE mbno = $2`,
                    [appliedAmount, dto.mbno]
                );
            }

            await queryRunner.commitTransaction();

            return {
                success: true,
                message: `Repayment of ₹${appliedAmount.toLocaleString('en-IN')} recorded for loan ${dto.loancaseno}. Remaining balance: ₹${newBalance.toLocaleString('en-IN')}`
            };
        } catch (error: any) {
            await queryRunner.rollbackTransaction();
            throw error;
        } finally {
            await queryRunner.release();
        }
    }

    async getMemberRepaymentHistory(mbno: string): Promise<any[]> {
        return this.dataSource.query(
            `SELECT
                lrl.id, lrl.loancaseno, lrl.loantype,
                lrl.payment_date, lrl.payment_month, lrl.payment_year,
                lrl.payment_amount, lrl.receipt_no, lrl.narration,
                lm.loan_amt, lm.balance as remaining_balance
             FROM loan_repayment_ledger lrl
             LEFT JOIN loan_master lm ON lm.loancaseno::text = lrl.loancaseno
             WHERE lrl.mbno = $1
             ORDER BY lrl.created_at DESC`,
            [mbno]
        );
    }

    async getLoanRepaymentSummary(loancaseno: string): Promise<any> {
        const rows = await this.dataSource.query(
            `SELECT
                lrl.loancaseno, lrl.loantype,
                lm.loan_amt as sanctioned_amount,
                lm.balance as current_balance,
                lm.no_of_instal as total_installments,
                lm.instal_amt as emi_amount,
                COALESCE(SUM(lrl.payment_amount), 0) as total_paid,
                COUNT(lrl.id) as payments_made
             FROM loan_master lm
             LEFT JOIN loan_repayment_ledger lrl ON lrl.loancaseno = lm.loancaseno::text
             WHERE lm.loancaseno::text = $1
             GROUP BY lrl.loancaseno, lrl.loantype, lm.loan_amt, lm.balance, lm.no_of_instal, lm.instal_amt`,
            [loancaseno]
        );
        return rows[0] || null;
    }
}
