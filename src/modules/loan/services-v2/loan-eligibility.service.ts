import { Injectable, BadRequestException } from '@nestjs/common';
import { DataSource } from 'typeorm';

export interface EligibilityStatus {
    isEligible: boolean;
    loanAmount: number;
    requiredShare: number;
    currentShare: number;
    additionalShareRequired: number;
    requiredFd: number;
    currentFd: number;
    additionalFdRequired: number;
    message?: string;
}

@Injectable()
export class LoanEligibilityService {
    constructor(private readonly dataSource: DataSource) {}

    /**
     * Check if a member meets the 5% Share and 5% FD rules for loans of 5,00,000 or more
     */
    async checkEligibility(memberNo: string, loanAmount: number): Promise<EligibilityStatus> {
        // BUG FIX 40: was `<= 500000`, exempting a loan of exactly ₹5,00,000 from the 5% check —
        // confirmed live, our own test loan for exactly ₹5,00,000 sailed through with zero shares.
        // User confirmed the rule should apply AT the threshold, not just above it.
        if (loanAmount < 500000) {
            return {
                isEligible: true,
                loanAmount,
                requiredShare: 0,
                currentShare: 0,
                additionalShareRequired: 0,
                requiredFd: 0,
                currentFd: 0,
                additionalFdRequired: 0,
                message: 'Loan amount is below 5,00,000. 5% eligibility rules do not apply.',
            };
        }

        const requiredShare = loanAmount * 0.05;
        const requiredFd = loanAmount * 0.05;

        // Fetch Current Share Value from member_balances
        const shareResult = await this.dataSource.query(
            `SELECT COALESCE(shares::numeric, 0) as shares FROM member_balances WHERE mbno = $1`,
            [memberNo]
        );
        const currentShare = Number(shareResult[0]?.shares || 0);

        // Fetch Current active FD Value from fdmaster
        const fdResult = await this.dataSource.query(
            `SELECT COALESCE(SUM(fdamount::numeric), 0) as fd_total 
             FROM fdmaster 
             WHERE mbno = $1 AND status = '0' AND fdrdflag = 'F'`,
            [memberNo]
        );
        const currentFd = Number(fdResult[0]?.fd_total || 0);

        // Calculate additional requirements (max of 0 and Required - Current)
        const additionalShareRequired = Math.max(0, requiredShare - currentShare);
        const additionalFdRequired = Math.max(0, requiredFd - currentFd);

        // Member is eligible only if both additional amounts are 0
        const isEligible = additionalShareRequired === 0 && additionalFdRequired === 0;

        return {
            isEligible,
            loanAmount,
            requiredShare,
            currentShare,
            additionalShareRequired,
            requiredFd,
            currentFd,
            additionalFdRequired,
            message: isEligible 
                ? 'Member is eligible for the loan.' 
                : 'Member does not meet the 5% Share or 5% FD requirements.',
        };
    }

    /**
     * Enforce eligibility during loan saving
     * Throws BadRequestException if not eligible
     */
    async enforceEligibility(memberNo: string, loanAmount: number): Promise<void> {
        const eligibility = await this.checkEligibility(memberNo, loanAmount);
        
        if (!eligibility.isEligible) {
            throw new BadRequestException(
                `Loan not eligible. ` +
                `Additional Share Required: ₹${eligibility.additionalShareRequired.toLocaleString('en-IN')}, ` +
                `Additional FD Required: ₹${eligibility.additionalFdRequired.toLocaleString('en-IN')}`
            );
        }
    }
}
