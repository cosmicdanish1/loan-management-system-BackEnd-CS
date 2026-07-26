import { Injectable, Logger } from '@nestjs/common';
import { DataSource } from 'typeorm';

/**
 * Member Balance Service - Handles member balance calculations and financial summaries.
 * 
 * @version 2.0 - Part of backend restructuring
 * Extracted from member.service.ts for single responsibility
 */
@Injectable()
export class MemberBalanceService {
    private readonly logger = new Logger(MemberBalanceService.name);

    constructor(private readonly dataSource: DataSource) { }

    /**
     * Get member balance information with comprehensive balance breakdown
     */
    async getMemberBalance(memberNo: string) {
        try {
            this.logger.debug(`Getting comprehensive balance for member: ${memberNo}`);

            // Get comprehensive member and balance info in a single query
            const comprehensiveQuery = `
        SELECT
          m.mbno, 
          TRIM(COALESCE(m.f_name, '') || ' ' || COALESCE(m.m_name, '') || ' ' || COALESCE(m.l_name, '')) as member_name,
          COALESCE(d.name, 'Unknown Office') as office_name,
          COALESCE(m.basic_pay, 0) as basic_pay,
          COALESCE(m.isactive, 'N') as is_active,
          -- Balance data from member_balances
          COALESCE(mb.shares, 0) as shares,
          COALESCE(mb.compulsory_deposit, 0) as compulsory_deposit,
          COALESCE(mb.rd_amt, 0) as rd_amount,
          COALESCE(mb.regularloan, 0) as regular_loan_balance,
          COALESCE(mb.emergency_loan_balance, 0) as emergency_loan_balance,
          COALESCE(mb.frsbalance, 0) as frs_balance
        FROM member_master m
        LEFT JOIN division_master d ON m.officeno = d.officeno AND m.wingno = d.wingno
        LEFT JOIN member_balances mb ON m.mbno = mb.mbno
        WHERE m.mbno = $1
      `;

            const result = await this.dataSource.query(comprehensiveQuery, [memberNo]);

            if (result.length === 0) {
                throw new Error('Member not found');
            }

            const member = result[0];

            // Get additional loan balances from loan_master if available
            let additionalLoanBalances: Record<string, number> = {};
            let totalLoanFromMaster = 0;

            try {
                const loanQuery = `
          SELECT
            COALESCE(loantype, 'UNKNOWN') as loantype,
            SUM(CASE 
              WHEN balance IS NOT NULL AND balance != '' 
              THEN balance::numeric
              ELSE 0
            END) as total_balance
          FROM loan_master
          WHERE mbno = $1 AND balance IS NOT NULL AND balance != ''
          GROUP BY loantype
        `;

                const loanResult = await this.dataSource.query(loanQuery, [memberNo]);

                loanResult.forEach((loan: any) => {
                    const balance = parseFloat(loan.total_balance) || 0;
                    if (balance > 0) {
                        additionalLoanBalances[loan.loantype || 'UNKNOWN'] = balance;
                        totalLoanFromMaster += balance;
                    }
                });
            } catch (error) {
                this.logger.warn('loan_master table query failed, using member_balances data only');
            }

            // Create comprehensive balance items
            const balanceItems: Array<{ code: string; headName: string; balance: number; type: string }> = [];

            // Assets
            const shares = parseFloat(member.shares) || 0;
            if (shares > 0) {
                balanceItems.push({
                    code: 'SH',
                    headName: 'Share Amount',
                    balance: shares,
                    type: 'asset'
                });
            }

            const compulsoryDeposit = parseFloat(member.compulsory_deposit) || 0;
            if (compulsoryDeposit > 0) {
                balanceItems.push({
                    code: 'CD',
                    headName: 'Compulsory Deposit',
                    balance: compulsoryDeposit,
                    type: 'asset'
                });
            }

            const rdAmount = parseFloat(member.rd_amount) || 0;
            if (rdAmount > 0) {
                balanceItems.push({
                    code: 'RD',
                    headName: 'Recurring Deposit',
                    balance: rdAmount,
                    type: 'asset'
                });
            }

            const frsBalance = parseFloat(member.frs_balance) || 0;
            if (frsBalance > 0) {
                balanceItems.push({
                    code: 'FRS',
                    headName: 'FRS Balance',
                    balance: frsBalance,
                    type: 'asset'
                });
            }

            // Liabilities
            const regularLoan = parseFloat(member.regular_loan_balance) || 0;
            if (regularLoan > 0) {
                balanceItems.push({
                    code: 'RLN',
                    headName: 'Regular Loan',
                    balance: -regularLoan, // Negative for liability
                    type: 'liability'
                });
            }

            const emergencyLoan = parseFloat(member.emergency_loan_balance) || 0;
            if (emergencyLoan > 0) {
                balanceItems.push({
                    code: 'ELN',
                    headName: 'Emergency Loan',
                    balance: -emergencyLoan, // Negative for liability
                    type: 'liability'
                });
            }

            // Add additional loans from loan_master
            Object.entries(additionalLoanBalances).forEach(([loanType, balance]) => {
                if (balance > 0) {
                    balanceItems.push({
                        code: loanType,
                        headName: `${loanType} Loan`,
                        balance: -balance, // Negative for liability
                        type: 'liability'
                    });
                }
            });

            // Calculate totals
            const totalAssets = balanceItems
                .filter(item => item.type === 'asset')
                .reduce((sum, item) => sum + item.balance, 0);

            const totalLiabilities = Math.abs(balanceItems
                .filter(item => item.type === 'liability')
                .reduce((sum, item) => sum + item.balance, 0));

            const netBalance = totalAssets - totalLiabilities;

            // Use loan_master total if available, otherwise use member_balances
            const finalLoanBalance = totalLoanFromMaster > 0 ? totalLoanFromMaster : (regularLoan + emergencyLoan);

            const balanceData = {
                memberInfo: {
                    memberNo: member.mbno,
                    memberName: member.member_name,
                    officeName: member.office_name,
                    basicPay: parseFloat(member.basic_pay) || 0,
                    isActive: member.is_active === 'Y'
                },
                loans: {
                    balances: Object.keys(additionalLoanBalances).length > 0 ? additionalLoanBalances : {
                        RLN: regularLoan,
                        ELN: emergencyLoan
                    },
                    totalBalance: finalLoanBalance
                },
                balanceItems: balanceItems,
                summary: {
                    totalAssets: totalAssets,
                    totalLiabilities: totalLiabilities,
                    netBalance: netBalance
                }
            };

            this.logger.debug(`Comprehensive balance calculated for member ${memberNo}: assets=${totalAssets}, liabilities=${totalLiabilities}, net=${netBalance}, items=${balanceItems.length}`);

            return balanceData;
        } catch (error) {
            this.logger.error(`Error getting member balance: ${error.message}`);
            throw error;
        }
    }

    /**
     * Get quick balance summary (lighter version for lists)
     */
    async getQuickBalance(memberNo: string) {
        try {
            const query = `
        SELECT
          COALESCE(mb.shares, 0) as shares,
          COALESCE(mb.compulsory_deposit, 0) as compulsory_deposit,
          COALESCE(mb.regularloan, 0) as regular_loan,
          COALESCE(mb.emergency_loan_balance, 0) as emergency_loan
        FROM member_balances mb
        WHERE mb.mbno = $1
      `;

            const result = await this.dataSource.query(query, [memberNo]);

            if (result.length === 0) {
                return {
                    shares: 0,
                    compulsoryDeposit: 0,
                    totalLoans: 0,
                    netBalance: 0
                };
            }

            const data = result[0];
            const assets = parseFloat(data.shares || 0) + parseFloat(data.compulsory_deposit || 0);
            const loans = parseFloat(data.regular_loan || 0) + parseFloat(data.emergency_loan || 0);

            return {
                shares: parseFloat(data.shares || 0),
                compulsoryDeposit: parseFloat(data.compulsory_deposit || 0),
                totalLoans: loans,
                netBalance: assets - loans
            };
        } catch (error) {
            this.logger.error(`Error getting quick balance: ${error.message}`);
            return {
                shares: 0,
                compulsoryDeposit: 0,
                totalLoans: 0,
                netBalance: 0
            };
        }
    }
}
