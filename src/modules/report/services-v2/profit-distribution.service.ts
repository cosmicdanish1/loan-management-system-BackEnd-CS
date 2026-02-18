import { Injectable, Logger } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { SystemConfigService } from '../../admin/services/system-config.service';

@Injectable()
export class ProfitDistributionService {
    private readonly logger = new Logger(ProfitDistributionService.name);

    constructor(
        private readonly dataSource: DataSource,
        private readonly systemConfigService: SystemConfigService,
    ) { }

    async calculateProjectedProfit(memberId: string) {
        // 1. Fetch Configuration Rates
        const fundIntRate = await this.systemConfigService.getConfigValue('RULE_FUND_INT_RATE'); // 7.0
        const dividendPct = await this.systemConfigService.getConfigValue('RULE_DIVIDEND_PCT');   // e.g., 5.0
        const insuranceAmt = await this.systemConfigService.getConfigValue('RULE_GRP_INSURANCE_AMT'); // e.g., 500
        const cdInterestChart = await this.systemConfigService.getConfigValue('RULE_CD_INTEREST_CHART'); // JSON [{amount: 200, interest: 91.20}]

        // 2. Fetch Member Balances (From Ledger)
        // Using identified codes: A1002 (Shares/Thrift - need to distinguish if possible, using same for now)
        const shareBalance = await this.getLedgerBalance(memberId, 'A1002');
        const thriftBalance = await this.getLedgerBalance(memberId, 'A1002'); // Placeholder if Thrift is same head or different

        // 3. Fetch Monthly Contribution (For CD Interest)
        // Assuming stored in RO tables or Member Master
        // We'll check ro_national first
        let monthlyContribution = 0;
        const roData = await this.dataSource.query(`
            SELECT "rd" FROM ro_national WHERE mbno = $1
            UNION ALL
            SELECT "rd" FROM ro_united WHERE mbno = $1
            LIMIT 1
        `, [memberId]);

        if (roData.length > 0) {
            monthlyContribution = Number(roData[0].rd) || 0;
        }

        // 4. Calculations

        // A. Fixed Interest on Current Balance (Fund/Thrift)
        const fixedInterest = (thriftBalance * fundIntRate) / 100;

        // B. Dividend on Shares
        const dividendAmount = (shareBalance * dividendPct) / 100;

        // C. Monthly FD Interest (CD Interest)
        // Find matching slab in chart
        let cdInterest = 0;
        if (Array.isArray(cdInterestChart)) {
            const slab = cdInterestChart.find((s: any) => s.amount === monthlyContribution);
            if (slab) {
                cdInterest = Number(slab.interest);
            } else {
                // Fallback or interpolation if needed
                // For now, if exact match not found, maybe 0 or warn
            }
        }

        // D. Group Insurance
        // Fixed deduction
        const insuranceDeduction = Number(insuranceAmt);

        // Total Projected Benefit
        const totalBenefit = fixedInterest + cdInterest + dividendAmount - insuranceDeduction;

        return {
            memberId,
            currentBalance: {
                shares: shareBalance,
                thrift: thriftBalance
            },
            monthlyContribution,
            breakdown: {
                fixedInterestOnBalance: fixedInterest, // (Current Balance * 7%)
                monthlyFdInterest: cdInterest,         // (From Chart)
                dividend: dividendAmount,              // (Shares * pct)
                groupInsurance: insuranceDeduction     // (Fixed)
            },
            totalProjectedCredit: totalBenefit,
            rates: {
                fundIntRate,
                dividendPct,
                insuranceAmt
            }
        };
    }

    private async getLedgerBalance(memberId: string, headCode: string): Promise<number> {
        // Sum(Credit) - Sum(Debit)
        // In this ledger schema: 
        // trans_type='R' (Receipt) -> Credit to member/Debit to Cash
        // trans_type='P' (Payment) -> Debit to member/Credit to Cash
        // However, for Member Passbook view:
        // Receipt (Depost) is Credit (+), Payment (Withdrawal) is Debit (-)

        const result = await this.dataSource.query(`
            SELECT 
                COALESCE(SUM(CASE WHEN trans_type = 'R' THEN trans_amt::numeric ELSE 0 END), 0) as total_credit,
                COALESCE(SUM(CASE WHEN trans_type = 'P' THEN trans_amt::numeric ELSE 0 END), 0) as total_debit
            FROM ledger 
            WHERE mbno = $1 AND code = $2
        `, [memberId, headCode]);

        const credit = parseFloat(result[0].total_credit);
        const debit = parseFloat(result[0].total_debit);

        return credit - debit;
    }
}
