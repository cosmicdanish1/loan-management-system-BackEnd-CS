import { Injectable, NotFoundException } from '@nestjs/common';
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
            console.error('[LoanQuery] Error getting loan from master:', error);
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
            console.error('[LoanQuery] Error getting loan from pending:', error);
            throw error;
        }
    }

    /**
     * Get all loans for a member from loan_master
     */
    async getMemberLoansFromMaster(memberNo: string) {
        try {
            const query = `
        SELECT 
          loancaseno,
          loantype,
          loan_amt::numeric as loan_amt,
          balance::numeric as balance,
          int_rate,
          no_of_instal,
          emi_amt,
          disburse_date
        FROM loan_master
        WHERE mbno = $1
        ORDER BY loancaseno DESC
      `;

            const result = await this.dataSource.query(query, [memberNo]);

            return result.map((loan: any) => ({
                loanCaseNo: loan.loancaseno,
                loanType: loan.loantype,
                loanAmount: parseFloat(loan.loan_amt) || 0,
                balance: parseFloat(loan.balance) || 0,
                interestRate: loan.int_rate,
                noOfInstallments: loan.no_of_instal,
                emiAmount: loan.emi_amt,
                disbursementDate: loan.disburse_date,
                status: 'ACTIVE'
            }));
        } catch (error) {
            console.error('[LoanQuery] Error getting member loans from master:', error);
            return [];
        }
    }

    /**
     * Get all pending loans for a member from loan_pending
     */
    async getMemberLoansFromPending(memberNo: string) {
        try {
            const query = `
        SELECT 
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
            console.error('[LoanQuery] Error getting member loans from pending:', error);
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
                const masterQuery = `
          SELECT 
            lm.loancaseno,
            lm.mbno,
            lm.loantype,
            lm.loan_amt::numeric as loan_amt,
            lm.balance::numeric as balance,
            'ACTIVE' as status,
            TRIM(COALESCE(mm.f_name, '') || ' ' || COALESCE(mm.l_name, '')) as member_name
          FROM loan_master lm
          JOIN member_master mm ON lm.mbno = mm.mbno
          WHERE 1=1
          ${query.memberNumber ? `AND lm.mbno = '${query.memberNumber}'` : ''}
          ${query.loanCaseNo ? `AND lm.loancaseno::text LIKE '%${query.loanCaseNo}%'` : ''}
          ${query.loanType ? `AND lm.loantype = '${query.loanType}'` : ''}
          ORDER BY lm.loancaseno DESC
          LIMIT 100
        `;

                const masterResults = await this.dataSource.query(masterQuery);
                results.push(...masterResults.map((r: any) => ({
                    ...r,
                    source: 'loan_master'
                })));
            }

            // Search in loan_pending (pending loans)
            if (!query.status || query.status === 'pending' || query.status === 'all') {
                const pendingQuery = `
          SELECT 
            lp.loancaseno,
            lp.mbno,
            lp.loantype,
            lp.applied_amt as loan_amt,
            lp.sanctioned_amt as balance,
            CASE 
              WHEN lp.flg_paid = 'Y' THEN 'DISBURSED'
              WHEN lp.flg_sanctioned = 'Y' THEN 'SANCTIONED'
              ELSE 'PENDING'
            END as status,
            TRIM(COALESCE(mm.f_name, '') || ' ' || COALESCE(mm.l_name, '')) as member_name
          FROM loan_pending lp
          JOIN member_master mm ON lp.mbno = mm.mbno
          WHERE 1=1
          ${query.memberNumber ? `AND lp.mbno = '${query.memberNumber}'` : ''}
          ${query.loanCaseNo ? `AND lp.loancaseno::text LIKE '%${query.loanCaseNo}%'` : ''}
          ${query.loanType ? `AND lp.loantype = '${query.loanType}'` : ''}
          ORDER BY lp.loancaseno DESC
          LIMIT 100
        `;

                const pendingResults = await this.dataSource.query(pendingQuery);
                results.push(...pendingResults.map((r: any) => ({
                    ...r,
                    source: 'loan_pending'
                })));
            }

            return results;
        } catch (error) {
            console.error('[LoanQuery] Error searching loans:', error);
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

            // Get payment status from demand_master for this member
            const demandQuery = `
                SELECT 
                    "demandforyear" as year,
                    "demandformonth" as month,
                    CASE 
                        WHEN ${loanMaster.loantype.toLowerCase()}amount > 0 THEN 'Paid'
                        ELSE 'Pending'
                    END as status
                FROM demand_master
                WHERE mbno = $1
                ORDER BY "demandforyear" ASC, "demandformonth" ASC
            `;

            const demandRecords = await this.dataSource.query(demandQuery, [loanMaster.mbno]);

            // Create a map of payment status by year-month
            const paymentStatusMap = new Map();
            demandRecords.forEach((record: any) => {
                const key = `${record.year}-${record.month}`;
                paymentStatusMap.set(key, record.status);
            });

            // Calculate EMI schedule
            const schedule = [];
            let balance = parseFloat(loanMaster.loan_amt);
            const monthlyRate = parseFloat(loanMaster.rate) / 100 / 12;
            const startDate = new Date(loanMaster.payment_date);
            const installments = parseInt(loanMaster.no_of_instal);

            // Calculate EMI using the installment amount from loan_master or formula
            const emiAmount = parseFloat(loanMaster.instal_amt) ||
                (balance * monthlyRate * Math.pow(1 + monthlyRate, installments)) /
                (Math.pow(1 + monthlyRate, installments) - 1);

            for (let month = 1; month <= installments; month++) {
                const interestAmount = balance * monthlyRate;
                const principalAmount = emiAmount - interestAmount;
                balance -= principalAmount;

                // Calculate due date
                const dueDate = new Date(startDate);
                dueDate.setMonth(dueDate.getMonth() + month - 1);

                // Determine payment status
                const yearMonth = `${dueDate.getFullYear()}-${dueDate.getMonth() + 1}`;
                let status = paymentStatusMap.get(yearMonth) || 'Pending';

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
            const remainingBalance = totalLoanAmount - totalPrincipalPaid;
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
            console.error('[LoanQuery] Error generating EMI schedule from master:', error);
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
