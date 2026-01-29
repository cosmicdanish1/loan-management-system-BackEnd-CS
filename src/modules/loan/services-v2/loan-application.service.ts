import { Injectable, BadRequestException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { SequenceGeneratorService } from '../../shared/services';
import { SystemConfigService } from '../../admin/services/system-config.service';

/**
 * Loan Application Service - Handles loan applications and case management.
 * 
 * @version 2.0 - Part of backend restructuring
 * Extracted from member.service.ts for single responsibility
 */
@Injectable()
export class LoanApplicationService {
    constructor(
        private readonly dataSource: DataSource,
        private readonly sequenceGenerator: SequenceGeneratorService,
        private readonly systemConfigService: SystemConfigService,
    ) { }

    /**
     * Generate next sequential loan case number
     */
    async generateNextLoanCaseNo(): Promise<string> {
        return this.sequenceGenerator.generateNextLoanCaseNo();
    }

    /**
     * Get existing loan cases for a member
     */
    async getMemberLoanCases(memberNo: string) {
        try {
            const query = `
        SELECT 
          loancaseno,
          loantype,
          loan_amt::numeric as loan_amt,
          balance::numeric as balance,
          purpose
        FROM loan_master
        WHERE mbno = $1
        ORDER BY loancaseno DESC
      `;

            const loanCases = await this.dataSource.query(query, [memberNo]);

            console.log(`[LoanApplication] Found ${loanCases.length} loan cases for member ${memberNo}`);

            return loanCases.map((loan: any) => ({
                memberNo,
                loanCaseNo: loan.loancaseno,
                loanType: loan.loantype,
                loanAmount: loan.loan_amt,
                balance: loan.balance,
                purpose: loan.purpose
            }));
        } catch (error) {
            console.error('[LoanApplication] Error getting member loan cases:', error);
            return [];
        }
    }

    /**
     * Save loan application
     */
    async saveLoanApplication(loanData: any) {
        try {
            console.log('[LoanApplication] Saving loan application:', loanData);

            // Validate loan eligibility - ensure amount is a number
            const amount = parseFloat(loanData.loanAmount || loanData.appliedAmount || 0);
            const installments = loanData.noOfInstallments || 60;
            await this.validateLoanEligibility(loanData.memberNo, amount, installments, loanData.loanType);

            // Map loan types to 3-character codes for database
            const loanTypeMapping: Record<string, string> = {
                'EMERGENCY': 'ELN',
                'REGULAR': 'RLN',
                'AGAINST': 'ALN',
                'EMERGENCY LOAN': 'ELN',
                'REGULAR LOAN': 'RLN',
                'LOAN AGAINST DEPOSIT': 'ALN',
                'Emergency': 'ELN',
                'Regular': 'RLN',
                'Against': 'ALN',
                'ELN': 'ELN',
                'RLN': 'RLN',
                'ALN': 'ALN'
            };

            const lookupKey = loanData.loanType ? loanData.loanType.toString() : '';
            const mappedLoanType = loanTypeMapping[lookupKey] ||
                loanTypeMapping[lookupKey.toUpperCase()] ||
                lookupKey.substring(0, 3).toUpperCase();

            // Generate loan case number if not provided
            let loanCaseNo = loanData.loanCaseNo;
            if (!loanCaseNo) {
                loanCaseNo = await this.sequenceGenerator.generateNextLoanCaseNo();
            }

            const insertQuery = `
        INSERT INTO loan_pending (
          mbno, loantype, loancaseno, applied_amt, sanctioned_amt, app_date,
          no_of_instal, purpose, flg_sanctioned, flg_paid, form_number, g1mbno, g2mbno
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
        RETURNING *
      `;

            const result = await this.dataSource.query(insertQuery, [
                loanData.memberNo,
                mappedLoanType,
                loanCaseNo,
                loanData.loanAmount || loanData.appliedAmount,
                0, // sanctioned_amt = 0 initially
                new Date(),
                loanData.noOfInstallments || 60,
                loanData.reason || loanData.purpose || '',
                'N', // flg_sanctioned = 'N'
                'N', // flg_paid = 'N'
                loanData.formNumber || '0',
                loanData.surety1 || '0',
                loanData.surety2 || '0'
            ]);

            console.log(`[LoanApplication] ✅ Loan application saved. Case No: ${loanCaseNo}`);

            return {
                success: true,
                message: 'Loan application saved successfully',
                loanCaseNo: loanCaseNo,
                data: result[0]
            };
        } catch (error: any) {
            console.error('[LoanApplication] ❌ Error saving loan application:', error);
            throw new Error('Failed to save loan application: ' + error.message);
        }
    }

    /**
     * Get all loan cases for loan payment processing
     */
    async getAllLoanCases() {
        try {
            const query = `
        SELECT 
          lp.loancaseno,
          lp.mbno,
          TRIM(COALESCE(mm.f_name, '') || ' ' || COALESCE(mm.m_name, '') || ' ' || COALESCE(mm.l_name, '')) as member_name,
          lp.loantype,
          lp.applied_amt,
          lp.sanctioned_amt,
          lp.flg_sanctioned,
          lp.flg_paid,
          lp.app_date as application_date
        FROM loan_pending lp
        JOIN member_master mm ON lp.mbno = mm.mbno
        WHERE lp.flg_paid = 'N'
        ORDER BY lp.app_date DESC
      `;

            const result = await this.dataSource.query(query);

            return result.map((loan: any) => ({
                loanCaseNo: loan.loancaseno,
                memberNo: loan.mbno,
                memberName: loan.member_name,
                loanType: loan.loantype,
                appliedAmount: loan.applied_amt,
                sanctionedAmount: loan.sanctioned_amt,
                applicationDate: loan.application_date,
                sanctioned: loan.flg_sanctioned === 'Y'
            }));
        } catch (error) {
            console.error('[LoanApplication] Error getting loan cases:', error);
            return [];
        }
    }

    /**
     * Get pending loan cases for a member (from loan_pending table)
     */
    async getMemberPendingLoans(memberNo: string) {
        try {
            const query = `
        SELECT 
          lp.loancaseno,
          lp.loantype,
          lp.applied_amt,
          lp.sanctioned_amt,
          lp.flg_sanctioned,
          lp.app_date
        FROM loan_pending lp
        WHERE lp.mbno = $1 AND lp.flg_paid = 'N'
        ORDER BY lp.app_date DESC
      `;

            const result = await this.dataSource.query(query, [memberNo]);

            return result.map((loan: any) => ({
                loanCaseNo: loan.loancaseno,
                loanType: loan.loantype,
                appliedAmount: loan.applied_amt,
                sanctionedAmount: loan.sanctioned_amt,
                sanctioned: loan.flg_sanctioned === 'Y',
                applicationDate: loan.app_date
            }));
        } catch (error) {
            console.error('[LoanApplication] Error getting member pending loans:', error);
            return [];
        }
    }

    /**
     * Validate loan eligibility (Dynamic Business Rules)
     */
    private async validateLoanEligibility(memberNo: string, amount: number, installments: number, loanType: string): Promise<void> {
        console.log(`[LoanApplication] Validating eligibility for ${loanType} loan...`);

        // 1. Determine which rules to use based on loan type
        const typePrefix = (loanType === 'ELN' || loanType?.toUpperCase().includes('EMERGENCY')) ? 'EL' : 'LT';
        const maxAmtKey = `RULE_LOAN_${typePrefix}_MAX_AMT`;
        const maxTenureKey = `RULE_LOAN_${typePrefix}_MAX_TENURE`;

        // 2. Fetch configured limits
        const maxLoanLimit = await this.systemConfigService.getConfigValue(maxAmtKey).catch(() => 500000);
        const maxTenure = await this.systemConfigService.getConfigValue(maxTenureKey).catch(() => 60);

        // 3. Check requested amount against configured limit
        // Only check outstanding balance for the SAME loan type
        const loanTypeFilter = typePrefix === 'EL' ? 'ELN' : 'RLN';
        const query = `
          SELECT SUM(balance)::numeric as total
          FROM loan_master
          WHERE mbno = $1 AND loantype = $2
        `;

        const result = await this.dataSource.query(query, [memberNo, loanTypeFilter]);
        const totalOutstanding = Number(result[0]?.total || 0);

        console.log(`[LoanApplication] Loan type: ${loanType}, Filter: ${loanTypeFilter}`);
        console.log(`[LoanApplication] Current outstanding for ${loanTypeFilter}: ₹${totalOutstanding.toLocaleString()}`);
        console.log(`[LoanApplication] Applied amount: ₹${amount.toLocaleString()}`);
        console.log(`[LoanApplication] Total would be: ₹${(totalOutstanding + amount).toLocaleString()}`);
        console.log(`[LoanApplication] Maximum limit: ₹${maxLoanLimit.toLocaleString()}`);

        if (totalOutstanding + amount > maxLoanLimit) {
            throw new BadRequestException(
                `Total loan amount exceeds maximum limit of ₹${maxLoanLimit.toLocaleString()} for ${typePrefix === 'EL' ? 'Emergency' : 'Regular'} loans. ` +
                `Current ${typePrefix === 'EL' ? 'Emergency' : 'Regular'} loan balance: ₹${totalOutstanding.toLocaleString()}, Applied: ₹${amount.toLocaleString()}`
            );
        }

        // 4. Check installments (tenure)
        if (installments > maxTenure) {
            throw new BadRequestException(
                `Requested tenure (${installments} months) exceeds maximum allowed tenure of ${maxTenure} months for ${typePrefix === 'EL' ? 'Emergency' : 'Regular'} loans.`
            );
        }

        console.log(`[LoanApplication] Eligibility check passed for member ${memberNo}`);
    }
}
