import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { CalculationService } from '../../utility/services/calculation.service';

/**
 * Loan Query Service - Handles loan searches and detail queries.
 * 
 * @version 2.0 - Part of backend restructuring
 * Extracted from loan.service.ts for single responsibility
 */
@Injectable()
export class LoanQueryService {
    private readonly logger = new Logger(LoanQueryService.name);

    constructor(
        private readonly dataSource: DataSource,
        private readonly calculationService: CalculationService,
    ) { }

    /**
     * Get member loan details from loan_master table (active/disbursed loans)
     */
    async getMemberLoanFromMaster(loanCaseNo: string) {
        try {
            const query = `
        SELECT 
          lm.*,
          TRIM(COALESCE(mm.f_name, '') || ' ' || COALESCE(mm.m_name, '') || ' ' || COALESCE(mm.l_name, '')) as member_name,
          mm.officeno,
          COALESCE(d.name, 'Unknown Office') as office_name
        FROM loan_master lm
        JOIN member_master mm ON lm.mbno = mm.mbno
        LEFT JOIN division_master d ON mm.officeno = d.officeno AND mm.wingno = d.wingno
        WHERE lm.loancaseno = $1
      `;

            const result = await this.dataSource.query(query, [loanCaseNo]);

            if (result.length === 0) {
                return null;
            }

            const loan = result[0];
            return {
                loanCaseNo: loan.loancaseno,
                memberNo: loan.mbno,
                memberName: loan.member_name,
                officeNo: loan.officeno,
                officeName: loan.office_name,
                loanType: loan.loantype,
                loanAmount: loan.loan_amt,
                balance: loan.balance,
                interestRate: loan.int_rate,
                noOfInstallments: loan.no_of_instal,
                emiAmount: loan.emi_amt,
                disbursementDate: loan.disburse_date,
                status: 'ACTIVE'
            };
        } catch (error) {
            this.logger.error(`Error getting loan from master: ${error.message}`);
            throw error;
        }
    }

    /**
     * Get member loan details from loan_pending table (pending/applied loans)
     */
    async getMemberLoanFromPending(loanCaseNo: string) {
        try {
            const query = `
        SELECT 
          lp.*,
          TRIM(COALESCE(mm.f_name, '') || ' ' || COALESCE(mm.m_name, '') || ' ' || COALESCE(mm.l_name, '')) as member_name,
          mm.officeno,
          COALESCE(d.name, 'Unknown Office') as office_name
        FROM loan_pending lp
        JOIN member_master mm ON lp.mbno = mm.mbno
        LEFT JOIN division_master d ON mm.officeno = d.officeno AND mm.wingno = d.wingno
        WHERE lp.loancaseno = $1
      `;

            const result = await this.dataSource.query(query, [loanCaseNo]);

            if (result.length === 0) {
                return null;
            }

            const loan = result[0];
            return {
                loanCaseNo: loan.loancaseno,
                memberNo: loan.mbno,
                memberName: loan.member_name,
                officeNo: loan.officeno,
                officeName: loan.office_name,
                loanType: loan.loantype,
                appliedAmount: loan.applied_amt,
                sanctionedAmount: loan.sanctioned_amt,
                applicationDate: loan.app_date,
                sanctionDate: loan.sanctioned_date,
                noOfInstallments: loan.no_of_instal,
                purpose: loan.purpose,
                sanctioned: loan.flg_sanctioned === 'Y',
                paid: loan.flg_paid === 'Y',
                surety1: loan.g1mbno,
                surety2: loan.g2mbno,
                status: loan.flg_paid === 'Y' ? 'DISBURSED' : loan.flg_sanctioned === 'Y' ? 'SANCTIONED' : 'PENDING'
            };
        } catch (error) {
            this.logger.error(`Error getting loan from pending: ${error.message}`);
            throw error;
        }
    }

    /**
     * Get all loans for a member from loan_master
     */
    async getMemberLoansFromMaster(memberNo: string) {
        try {
            const query = `
        SELECT DISTINCT ON (loancaseno)
          loancaseno,
          loantype,
          loan_amt::numeric as loan_amt,
          balance::numeric as balance,
          rate,
          no_of_instal,
          instal_amt::numeric as instal_amt,
          payment_date
        FROM loan_master
        WHERE CAST(mbno AS TEXT) = $1
        ORDER BY loancaseno DESC
      `;

            const result = await this.dataSource.query(query, [memberNo]);

            return result.map((loan: any) => ({
                loancaseno: loan.loancaseno,
                loantype: loan.loantype,
                loan_amt: parseFloat(loan.loan_amt) || 0,
                balance: parseFloat(loan.balance) || 0,
                int_rate: loan.rate,
                no_of_instal: loan.no_of_instal,
                instal_amt: parseFloat(loan.instal_amt) || 0,
                disburse_date: loan.payment_date,
                status: 'ACTIVE'
            }));
        } catch (error) {
            this.logger.error(`Error getting member loans from master: ${error.message}`);
            return [];
        }
    }

    /**
     * Get all pending loans for a member from loan_pending
     */
    async getMemberLoansFromPending(memberNo: string) {
        try {
            const query = `
        SELECT DISTINCT ON (loancaseno)
          loancaseno,
          loantype,
          applied_amt,
          sanctioned_amt,
          app_date,
          sanctioned_date,
          no_of_instal,
          purpose,
          flg_sanctioned,
          flg_paid,
          g1mbno,
          g2mbno
        FROM loan_pending
        WHERE mbno = $1
        ORDER BY loancaseno DESC
      `;

            const result = await this.dataSource.query(query, [memberNo]);

            return result.map((loan: any) => ({
                loanCaseNo: loan.loancaseno,
                loanType: loan.loantype,
                appliedAmount: loan.applied_amt,
                sanctionedAmount: loan.sanctioned_amt,
                applicationDate: loan.app_date,
                sanctionDate: loan.sanctioned_date,
                noOfInstallments: loan.no_of_instal,
                purpose: loan.purpose,
                sanctioned: loan.flg_sanctioned === 'Y',
                paid: loan.flg_paid === 'Y',
                surety1: loan.g1mbno,
                surety2: loan.g2mbno,
                status: loan.flg_paid === 'Y' ? 'DISBURSED' : loan.flg_sanctioned === 'Y' ? 'SANCTIONED' : 'PENDING'
            }));
        } catch (error) {
            this.logger.error(`Error getting member loans from pending: ${error.message}`);
            return [];
        }
    }

    /**
     * Search loans across both loan_master and loan_pending
     */
    async searchMemberLoans(query: {
        memberNumber?: string;
        loanCaseNo?: string;
        loanType?: string;
        status?: 'active' | 'pending' | 'all';
    }) {
        try {
            const results: any[] = [];

            // Search in loan_master (active loans)
            if (!query.status || query.status === 'active' || query.status === 'all') {
                const masterParams: any[] = [];
                const masterConditions: string[] = [];
                if (query.memberNumber) {
                    masterParams.push(query.memberNumber);
                    masterConditions.push(`AND lm.mbno = $${masterParams.length}`);
                }
                if (query.loanCaseNo) {
                    masterParams.push(`%${query.loanCaseNo}%`);
                    masterConditions.push(`AND lm.loancaseno::text LIKE $${masterParams.length}`);
                }
                if (query.loanType) {
                    masterParams.push(query.loanType);
                    masterConditions.push(`AND lm.loantype = $${masterParams.length}`);
                }

                const masterQuery = `
          SELECT
            lm.loancaseno,
            lm.mbno,
            lm.loantype,
            lm.loan_amt::numeric as loan_amt,
            lm.balance::numeric as balance,
            lm.instal_amt::numeric as instal_amt,
            lm.no_of_instal,
            lm.rate::numeric as rate,
            'ACTIVE' as status,
            TRIM(COALESCE(mm.f_name, '') || ' ' || COALESCE(mm.l_name, '')) as member_name
          FROM loan_master lm
          JOIN member_master mm ON lm.mbno = mm.mbno
          WHERE 1=1
          ${masterConditions.join('\n          ')}
          ORDER BY lm.loancaseno DESC
          LIMIT 100
        `;

                const masterResults = await this.dataSource.query(masterQuery, masterParams);
                results.push(...masterResults.map((r: any) => ({
                    ...r,
                    source: 'loan_master'
                })));
            }

            // Search in loan_pending (pending loans)
            if (!query.status || query.status === 'pending' || query.status === 'all') {
                const pendingParams: any[] = [];
                const pendingConditions: string[] = [];
                if (query.memberNumber) {
                    pendingParams.push(query.memberNumber);
                    pendingConditions.push(`AND lp.mbno = $${pendingParams.length}`);
                }
                if (query.loanCaseNo) {
                    pendingParams.push(`%${query.loanCaseNo}%`);
                    pendingConditions.push(`AND lp.loancaseno::text LIKE $${pendingParams.length}`);
                }
                if (query.loanType) {
                    pendingParams.push(query.loanType);
                    pendingConditions.push(`AND lp.loantype = $${pendingParams.length}`);
                }

                const pendingQuery = `
          SELECT
            lp.loancaseno,
            lp.mbno,
            lp.loantype,
            lp.applied_amt as loan_amt,
            lp.sanctioned_amt as balance,
            lp.no_of_instal,
            lp.rate::numeric as rate,
            CASE
              WHEN lp.flg_paid = 'Y' THEN 'DISBURSED'
              WHEN lp.flg_sanctioned = 'Y' THEN 'SANCTIONED'
              ELSE 'PENDING'
            END as status,
            TRIM(COALESCE(mm.f_name, '') || ' ' || COALESCE(mm.l_name, '')) as member_name
          FROM loan_pending lp
          JOIN member_master mm ON lp.mbno = mm.mbno
          WHERE 1=1
          ${pendingConditions.join('\n          ')}
          ORDER BY lp.loancaseno DESC
          LIMIT 100
        `;

                const pendingResults = await this.dataSource.query(pendingQuery, pendingParams);
                results.push(...pendingResults.map((r: any) => ({
                    ...r,
                    source: 'loan_pending'
                })));
            }

            return results;
        } catch (error) {
            this.logger.error(`Error searching loans: ${error.message}`);
            return [];
        }
    }

    /**
     * Get EMI schedule from loan_master with payment status from demand_master
     */
    async getEmiScheduleFromMaster(loanCaseNo: string) {
        try {
            // Get loan details from loan_master
            const loanQuery = `
                SELECT 
                    lm.*,
                    TRIM(COALESCE(mm.f_name, '') || ' ' || COALESCE(mm.m_name, '') || ' ' || COALESCE(mm.l_name, '')) as member_name,
                    mm.officeno,
                    mm.basic_pay,
                    mm.dept_name
                FROM loan_master lm
                JOIN member_master mm ON lm.mbno = mm.mbno
                WHERE lm.loancaseno = $1
            `;

            const loanResult = await this.dataSource.query(loanQuery, [loanCaseNo]);

            if (loanResult.length === 0) {
                throw new NotFoundException(`Loan case ${loanCaseNo} not found in loan_master`);
            }

            const loanMaster = loanResult[0];

            // Get payment status from demand_master for this member.
            // (Real columns are demand_for_year/demand_for_month — the previous
            // "demandforyear"/"<type>amount" names don't exist on this table and
            // made every call to this endpoint throw.)
            const demandQuery = `
                SELECT
                    demand_for_year as year,
                    demand_for_month as month,
                    CASE
                        WHEN COALESCE(balance_for_month, 0) <= 0 THEN 'Paid'
                        ELSE 'Pending'
                    END as status
                FROM demand_master
                WHERE mbno = $1
                ORDER BY demand_for_year ASC, demand_for_month ASC
            `;

            const demandRecords = await this.dataSource.query(demandQuery, [loanMaster.mbno]);

            // Create a map of payment status by year-month
            const paymentStatusMap = new Map();
            demandRecords.forEach((record: any) => {
                const key = `${record.year}-${record.month}`;
                paymentStatusMap.set(key, record.status);
            });

            // BUG FIX 50: status here only ever checked demand_master — but the
            // individual Loan Repayment screen writes real payments to
            // loan_repayment_ledger (and loan_master.balance) and never touches
            // demand_master at all (only the bulk Ledger Posting/recovery path
            // does). Confirmed live: a loan with 2 real recorded repayments showed
            // every installment as Overdue/Pending, "Cleared Principal: ₹0", "Debt
            // Clearance: 0.0%" — none of it reflected the real ₹4,264 already paid
            // (which does exactly reconcile: loan_amt 24000 - 4264 = loanMaster's
            // real balance 19736). Fetching real repayments here and using their
            // actual principal/interest split for the corresponding installments so
            // "Paid" rows reflect what actually happened instead of a theoretical
            // projection that never looked at payment history.
            const repaymentRows = await this.dataSource.query(
                `SELECT principal_amount, interest_amount, payment_date, payment_month, payment_year
                 FROM loan_repayment_ledger
                 WHERE loancaseno = $1
                 ORDER BY payment_date ASC, id ASC`,
                [loanCaseNo]
            );

            // BUG FIX 51: the above rows used to be paired to schedule months by
            // array position (repaymentRows[month - 1]), assuming exactly one row
            // per installment posted in due-date order. Confirmed live on loan
            // 888987: it has 13 real ledger rows for a 12-installment loan (one
            // installment was posted as two separate rows), and several rows share
            // the same payment_date so id order — not the row's own
            // payment_month/payment_year — decided the pairing. The loop only ever
            // read indices 0-11, so the 13th row (the only one with nonzero
            // interest, ₹15.78) was silently dropped from both the table and the
            // summary totals, and the remaining rows were shown against due dates
            // one calendar month off from what they actually paid. Grouping by each
            // row's own payment_year/payment_month instead — summing rows that
            // share a month — fixes both: nothing is dropped, and a schedule row is
            // only marked Paid using the repayment(s) actually recorded for that
            // calendar month.
            const realPaymentsByMonth = new Map<string, { principal: number; interest: number }>();
            repaymentRows.forEach((row: any) => {
                const key = `${row.payment_year}-${row.payment_month}`;
                const existing = realPaymentsByMonth.get(key) || { principal: 0, interest: 0 };
                existing.principal += parseFloat(row.principal_amount) || 0;
                existing.interest += parseFloat(row.interest_amount) || 0;
                realPaymentsByMonth.set(key, existing);
            });

            // Calculate EMI schedule using equalised interest: constant principal
            // (loan amount / months) + constant interest (total interest / months)
            // every month, per the loan calculation spec — matches how
            // LoanRepaymentService now decomposes an actual repayment, instead of
            // a reducing-balance split where principal/interest varied per month.
            const schedule = [];
            const loanAmt = parseFloat(loanMaster.loan_amt);
            const startDate = new Date(loanMaster.payment_date);
            const installments = parseInt(loanMaster.no_of_instal);

            const monthlyPrincipal = installments > 0 ? loanAmt / installments : 0;
            const storedEmi = parseFloat(loanMaster.instal_amt) || 0;
            const monthlyRateForFallback = parseFloat(loanMaster.rate) / 100 / 12;
            // The standard reducing-balance formula is used once here, only to size
            // total interest when no EMI has been recorded yet — not to vary the
            // monthly split, which stays constant per the equalised method.
            const emiAmount = storedEmi || (installments > 0
                ? (loanAmt * monthlyRateForFallback * Math.pow(1 + monthlyRateForFallback, installments)) /
                  (Math.pow(1 + monthlyRateForFallback, installments) - 1)
                : 0);
            const totalInterest = Math.max(0, emiAmount * installments - loanAmt);
            const monthlyInterest = installments > 0 ? totalInterest / installments : 0;

            let balance = loanAmt;
            for (let month = 1; month <= installments; month++) {
                // Calculate due date
                const dueDate = new Date(startDate);
                dueDate.setMonth(dueDate.getMonth() + month - 1);

                const realPayment = realPaymentsByMonth.get(`${dueDate.getFullYear()}-${dueDate.getMonth() + 1}`);
                const principalAmount = realPayment
                    ? Math.min(realPayment.principal, balance)
                    : Math.min(monthlyPrincipal, balance);
                const interestAmount = realPayment
                    ? realPayment.interest
                    : monthlyInterest;
                balance = Math.max(0, balance - principalAmount);

                // Determine payment status — a real recorded repayment always wins
                let status = realPayment ? 'Paid' : (paymentStatusMap.get(`${dueDate.getFullYear()}-${dueDate.getMonth() + 1}`) || 'Pending');

                // If due date is past and status is pending, mark as overdue
                if (status === 'Pending' && dueDate < new Date()) {
                    status = 'Overdue';
                }

                schedule.push({
                    month,
                    dueDate: dueDate.toISOString().split('T')[0],
                    emiAmount: Math.round(emiAmount * 100) / 100,
                    principalAmount: Math.round(principalAmount * 100) / 100,
                    interestAmount: Math.round(interestAmount * 100) / 100,
                    balance: Math.max(0, Math.round(balance * 100) / 100),
                    status,
                });
            }

            // Calculate summary statistics
            const paidInstallments = schedule.filter(item => item.status === 'Paid').length;
            const pendingInstallments = schedule.filter(item => item.status === 'Pending').length;
            const overdueInstallments = schedule.filter(item => item.status === 'Overdue').length;

            const totalPaid = schedule
                .filter(item => item.status === 'Paid')
                .reduce((sum, item) => sum + item.emiAmount, 0);

            const totalInterestPaid = schedule
                .filter(item => item.status === 'Paid')
                .reduce((sum, item) => sum + item.interestAmount, 0);

            const totalPrincipalPaid = schedule
                .filter(item => item.status === 'Paid')
                .reduce((sum, item) => sum + item.principalAmount, 0);

            const totalLoanAmount = parseFloat(loanMaster.loan_amt);
            // Use loan_master's own balance rather than totalLoanAmount - totalPrincipalPaid:
            // the schedule only covers `installments` calendar months from the loan's start
            // date, so a real repayment recorded outside that window (e.g. postings that
            // started a month late, pushing the last one past the theoretical final due date)
            // is real principal loan_master already accounts for but that this fixed-length
            // schedule has nowhere to display — recomputing from the schedule alone would then
            // show a nonzero "remaining balance" on a loan that is, per its ledger of record,
            // actually fully paid.
            const remainingBalance = parseFloat(loanMaster.balance);
            const completionPercentage = (paidInstallments / installments) * 100;

            return {
                loanDetails: {
                    loanCaseNo: loanMaster.loancaseno,
                    memberNumber: loanMaster.mbno,
                    memberName: loanMaster.member_name,
                    loanType: loanMaster.loantype,
                    loanAmount: totalLoanAmount,
                    rate: parseFloat(loanMaster.rate),
                    noOfInstallments: installments,
                    installmentAmount: parseFloat(loanMaster.instal_amt),
                    balance: parseFloat(loanMaster.balance),
                    purpose: loanMaster.purpose || 'Personal Use',
                    paymentDate: loanMaster.payment_date,
                    officeName: `${loanMaster.officeno}-${loanMaster.dept_name || 'N/A'}`,
                    basicPay: parseFloat(loanMaster.basic_pay || 0),
                },
                schedule,
                summary: {
                    paidInstallments,
                    pendingInstallments,
                    overdueInstallments,
                    totalPaid: Math.round(totalPaid * 100) / 100,
                    totalInterestPaid: Math.round(totalInterestPaid * 100) / 100,
                    totalPrincipalPaid: Math.round(totalPrincipalPaid * 100) / 100,
                    remainingBalance: Math.round(remainingBalance * 100) / 100,
                    completionPercentage: Math.round(completionPercentage * 100) / 100,
                },
            };
        } catch (error) {
            this.logger.error(`Error generating EMI schedule from master: ${error.message}`);
            throw error;
        }
    }

    /**
     * Calculate EMI for given parameters
     */
    async calculateEMI(principal: number, annualRate: number, tenureMonths: number) {
        return this.calculationService.calculateEMI(principal, annualRate, tenureMonths);
    }

    /**
     * Generate amortization schedule
     */
    async generateAmortizationSchedule(principal: number, annualRate: number, tenureMonths: number, startDate?: Date) {
        return this.calculationService.generateAmortizationSchedule(
            principal,
            annualRate,
            tenureMonths,
            startDate || new Date()
        );
    }
}
