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
        // Adjust Head Codes as per actual database (e.g., A1002 for Shares, A1003 for Thrift)
        // We'll calculate current balance by summing ledger
        const shareBalance = await this.getLedgerBalance(memberId, 'SHARE_HEAD_CODE');
        const thriftBalance = await this.getLedgerBalance(memberId, 'THRIFT_HEAD_CODE');

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
        // Mock head code logic: In real app, look up HEAD code for 'Shares'
        // Here we assume a generic balance query on ledger
        // Sum(Credit) - Sum(Debit)
        // But for now, returning 0 or mock as we don't have exact head codes
        // TODO: Update head codes once identified
        return 0;
    }
}
