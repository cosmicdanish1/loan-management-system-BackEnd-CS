import { Injectable, NotFoundException } from '@nestjs/common';
import { DataSource } from 'typeorm';

/** Money rounded to paise, so sums of decimal amounts do not drift (0.1 + 0.2 = 0.3) */
const round2 = (n: number): number => Math.round((n + Number.EPSILON) * 100) / 100;

/** Loan types that member_balances keeps in its own columns: the regular loan and the emergency loan */
const REGULAR_TYPES = ['RLN', 'R', 'REG'];
const EMERGENCY_TYPES = ['ELN', 'ALN', 'E', 'EMR', 'A', 'ADD'];

type LoanLine = { code: string; headName: string; amount: number };

/**
 * The loans of a member as liabilities, each loan counted once (ES-396). member_balances holds a regular and an
 * emergency figure, and loan_master holds the same loans again per loan type. One source per kind of loan: when
 * loan_master has rows for the regular (or emergency) loan types they are used, otherwise the member_balances figure.
 * Every other loan type comes from loan_master.
 */
function buildLoanLines(regularLoan: number, emergencyLoan: number, masterByType: Record<string, number>): LoanLine[] {
    const masterEntries = Object.entries(masterByType).filter(([, amount]) => amount > 0);
    const masterHas = (types: string[]) => masterEntries.some(([type]) => types.includes(type.toUpperCase()));
    const lines: LoanLine[] = [];
    if (regularLoan > 0 && !masterHas(REGULAR_TYPES)) lines.push({ code: 'RLN', headName: 'Regular Loan', amount: regularLoan });
    if (emergencyLoan > 0 && !masterHas(EMERGENCY_TYPES)) lines.push({ code: 'ELN', headName: 'Emergency Loan', amount: emergencyLoan });
    for (const [type, amount] of masterEntries) lines.push({ code: type, headName: `${type} Loan`, amount });
    return lines;
}

/**
 * Member Balance Service - Handles member balance calculations and financial summaries.
 *
 * @version 2.0 - Part of backend restructuring
 * Extracted from member.service.ts for single responsibility
 */
@Injectable()
export class MemberBalanceService {
    constructor(private readonly dataSource: DataSource) { }

    /** Outstanding balance per loan type from loan_master (empty when that table cannot be read) */
    private async loanMasterByType(memberNo: string): Promise<Record<string, number>> {
        const byType: Record<string, number> = {};
        try {
            const loanResult = await this.dataSource.query(
                `SELECT
                    COALESCE(loantype, 'UNKNOWN') as loantype,
                    SUM(CASE WHEN balance IS NOT NULL AND balance != '' THEN balance::numeric ELSE 0 END) as total_balance
                 FROM loan_master
                 WHERE mbno = $1 AND balance IS NOT NULL AND balance != ''
                 GROUP BY loantype`,
                [memberNo],
            );
            for (const loan of loanResult) {
                const balance = parseFloat(loan.total_balance) || 0;
                if (balance > 0) {
                    const key = loan.loantype || 'UNKNOWN';
                    byType[key] = round2((byType[key] || 0) + balance);
                }
            }
        } catch (error) {
            console.log('[MemberBalance] loan_master table query failed, using member_balances data only');
        }
        return byType;
    }

    /**
     * Get member balance information with comprehensive balance breakdown
     */
    async getMemberBalance(memberNo: string) {
        try {
            console.log(`[MemberBalance] Getting comprehensive balance for member: ${memberNo}`);

            // Get comprehensive member and balance info in a single query
            const comprehensiveQuery = `
        SELECT
          m.mbno,
          REGEXP_REPLACE(TRIM(COALESCE(m.f_name, '') || ' ' || COALESCE(m.m_name, '') || ' ' || COALESCE(m.l_name, '')), '\\s+', ' ', 'g') as member_name,
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
                throw new NotFoundException('Member not found');
            }

            const member = result[0];

            const masterByType = await this.loanMasterByType(memberNo);

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

            // Liabilities: every loan once (member_balances figures plus the loan_master types it has no column for)
            const regularLoan = parseFloat(member.regular_loan_balance) || 0;
            const emergencyLoan = parseFloat(member.emergency_loan_balance) || 0;
            const loanLines = buildLoanLines(regularLoan, emergencyLoan, masterByType);
            for (const line of loanLines) {
                balanceItems.push({
                    code: line.code,
                    headName: line.headName,
                    balance: -line.amount, // Negative for liability
                    type: 'liability'
                });
            }

            // Calculate totals (rounded to paise)
            const totalAssets = round2(balanceItems
                .filter(item => item.type === 'asset')
                .reduce((sum, item) => sum + item.balance, 0));

            const totalLiabilities = round2(Math.abs(balanceItems
                .filter(item => item.type === 'liability')
                .reduce((sum, item) => sum + item.balance, 0)));

            const netBalance = round2(totalAssets - totalLiabilities);

            const loanBalances: Record<string, number> = {};
            for (const line of loanLines) loanBalances[line.code] = line.amount;

            const balanceData = {
                memberInfo: {
                    memberNo: member.mbno,
                    memberName: member.member_name,
                    officeName: member.office_name,
                    basicPay: parseFloat(member.basic_pay) || 0,
                    isActive: member.is_active === 'Y'
                },
                loans: {
                    // with no loan at all the two member_balances figures are shown, as before
                    balances: loanLines.length > 0 && Object.keys(masterByType).length > 0 ? loanBalances : {
                        RLN: regularLoan,
                        ELN: emergencyLoan
                    },
                    totalBalance: totalLiabilities
                },
                balanceItems: balanceItems,
                summary: {
                    totalAssets: totalAssets,
                    totalLiabilities: totalLiabilities,
                    netBalance: netBalance
                }
            };

            console.log(`[MemberBalance] Comprehensive balance calculated for member ${memberNo}:`, {
                memberName: member.member_name,
                totalAssets: totalAssets,
                totalLiabilities: totalLiabilities,
                netBalance: netBalance,
                balanceItemsCount: balanceItems.length
            });

            return balanceData;
        } catch (error) {
            console.error('[MemberBalance] Error getting member balance:', error);
            throw error;
        }
    }

    /**
     * Get quick balance summary (lighter version for lists).
     * Uses the same asset and loan rules as getMemberBalance, so the net figure is the same for the same member (ES-396).
     */
    async getQuickBalance(memberNo: string) {
        try {
            const query = `
        SELECT
          COALESCE(mb.shares, 0) as shares,
          COALESCE(mb.compulsory_deposit, 0) as compulsory_deposit,
          COALESCE(mb.rd_amt, 0) as rd_amount,
          COALESCE(mb.frsbalance, 0) as frs_balance,
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
            const shares = parseFloat(data.shares) || 0;
            const compulsoryDeposit = parseFloat(data.compulsory_deposit) || 0;
            const assets = round2(shares + compulsoryDeposit + (parseFloat(data.rd_amount) || 0) + (parseFloat(data.frs_balance) || 0));

            const masterByType = await this.loanMasterByType(memberNo);
            const loans = round2(
                buildLoanLines(parseFloat(data.regular_loan) || 0, parseFloat(data.emergency_loan) || 0, masterByType)
                    .reduce((sum, line) => sum + line.amount, 0),
            );

            return {
                shares,
                compulsoryDeposit,
                totalLoans: loans,
                netBalance: round2(assets - loans)
            };
        } catch (error) {
            // a failure is reported: showing zeros would look like "this member has no money and no loans"
            console.error('[MemberBalance] Error getting quick balance:', error);
            throw error;
        }
    }
}
