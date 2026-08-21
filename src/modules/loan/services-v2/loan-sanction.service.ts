import { Injectable, Logger, BadRequestException, NotFoundException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { parseSafeDate } from '../../shared/utils/date-utils';

/**
 * Loan Sanction Service - Handles loan sanction and approval operations.
 * 
 * @version 2.0 - Part of backend restructuring
 * Extracted from member.service.ts for single responsibility
 */
@Injectable()
export class LoanSanctionService {
    private readonly logger = new Logger(LoanSanctionService.name);

    constructor(private readonly dataSource: DataSource) { }

    /**
     * Get all sanctioned loan cases ready for disbursement
     */
    async getSanctionedLoanCases() {
        try {
            const query = `
        SELECT DISTINCT ON (lp.loancaseno)
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
        WHERE lp.flg_sanctioned = 'Y'
          AND lp.flg_paid = 'N'
          AND NOT EXISTS (
              SELECT 1 FROM loan_master lm
              WHERE lm.loancaseno::text = lp.loancaseno::text
          )
          AND NOT EXISTS (
              SELECT 1 FROM vouchers v
              -- BUG FIX 29: was '%LOAN_CASE:' || loancaseno || '%' with no trailing delimiter —
              -- case "5" would also match a voucher's remarks for case "50", "512", etc. since
              -- "LOAN_CASE:5" is a substring of "LOAN_CASE:50". generateLoanVoucher always writes
              -- "LOAN_CASE:{caseNo}|PAY_MODE:...", so matching through the "|" makes this exact.
              WHERE v.remarks LIKE '%LOAN_CASE:' || lp.loancaseno || '|%'
              AND v.status IN ('PENDING', 'POSTED')
          )
        ORDER BY lp.loancaseno, lp.app_date ASC
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
                sanctioned: true
            }));
        } catch (error) {
            this.logger.error(`Error getting sanctioned loan cases: ${error.message}`);
            return [];
        }
    }

    /**
     * Get loan details by case number
     */
    async getLoanDetailsByCaseNo(caseNo: string) {
        try {
            const query = `
        SELECT 
          lp.*,
          TRIM(COALESCE(mm.f_name, '') || ' ' || COALESCE(mm.m_name, '') || ' ' || COALESCE(mm.l_name, '')) as member_name,
          mm.officeno,
          mm.basic_pay,
          COALESCE(d.name, 'Unknown Office') as office_name,
          COALESCE(mb.shares, 0) as share_amount,
          COALESCE(mb.regularloan, 0) as regular_loan_balance,
          COALESCE(mb.emergency_loan_balance, 0) as emergency_loan_balance,
          
          -- Derive Account Head Code & Name based on Loan Type
          CASE 
            WHEN lp.loantype = 'R' OR lp.loantype = 'REG' OR lp.loantype = 'RLN' THEN 'A1002'
            WHEN lp.loantype = 'E' OR lp.loantype = 'EMR' OR lp.loantype = 'ELN' THEN 'A1047'
            ELSE 'A1047'
          END as h_code,
          
          -- BUG FIX 30: same oversight as h_code's ALN mapping — ALN (the type every real loan
          -- in this system actually uses) fell through to the generic "LOAN ACCOUNT" label
          -- instead of "EMERGENCY LOAN", even though h_code already correctly resolved to A1047.
          CASE
            WHEN lp.loantype = 'R' OR lp.loantype = 'REG' OR lp.loantype = 'RLN' THEN 'REGULAR LOAN'
            WHEN lp.loantype = 'E' OR lp.loantype = 'EMR' OR lp.loantype = 'ELN' OR lp.loantype = 'A' OR lp.loantype = 'ALN' THEN 'EMERGENCY LOAN'
            ELSE 'LOAN ACCOUNT'
          END as h_name,

          -- Surety 1 Details
          TRIM(COALESCE(s1.f_name, '') || ' ' || COALESCE(s1.m_name, '') || ' ' || COALESCE(s1.l_name, '')) as s1_name,
          COALESCE(s1_d.name, 'Unknown Office') as s1_office,
          (COALESCE(s1_mb.regularloan, 0) + COALESCE(s1_mb.emergency_loan_balance, 0)) as s1_loan_balance,

          -- Surety 2 Details
          TRIM(COALESCE(s2.f_name, '') || ' ' || COALESCE(s2.m_name, '') || ' ' || COALESCE(s2.l_name, '')) as s2_name,
          COALESCE(s2_d.name, 'Unknown Office') as s2_office,
          (COALESCE(s2_mb.regularloan, 0) + COALESCE(s2_mb.emergency_loan_balance, 0)) as s2_loan_balance

        FROM loan_pending lp
        JOIN member_master mm ON lp.mbno = mm.mbno
        LEFT JOIN division_master d ON mm.officeno = d.officeno AND mm.wingno = d.wingno
        LEFT JOIN member_balances mb ON lp.mbno = mb.mbno

        -- Join for Surety 1
        LEFT JOIN member_master s1 ON lp.g1mbno = s1.mbno
        LEFT JOIN division_master s1_d ON s1.officeno = s1_d.officeno AND s1.wingno = s1_d.wingno
        LEFT JOIN member_balances s1_mb ON s1.mbno = s1_mb.mbno

        -- Join for Surety 2
        LEFT JOIN member_master s2 ON lp.g2mbno = s2.mbno
        LEFT JOIN division_master s2_d ON s2.officeno = s2_d.officeno AND s2.wingno = s2_d.wingno
        LEFT JOIN member_balances s2_mb ON s2.mbno = s2_mb.mbno

        WHERE lp.loancaseno = $1
      `;

            const result = await this.dataSource.query(query, [caseNo]);

            if (result.length === 0) {
                return null;
            }

            const loan = result[0];
            this.logger.log(`Fetched Loan Details for Case: ${caseNo}`);

            return {
                loanCaseNo: loan.loancaseno,
                memberNo: loan.mbno,
                memberName: loan.member_name,
                officeNo: loan.officeno,
                officeName: loan.office_name,
                loanType: loan.loantype,
                hCode: loan.h_code,
                hName: loan.h_name,
                appliedAmount: loan.applied_amt,
                sanctionedAmount: loan.sanctioned_amt,
                applicationDate: loan.app_date,
                sanctionDate: loan.sanctioned_date,
                noOfInstallments: loan.no_of_instal,
                purpose: loan.purpose,
                formNumber: loan.form_number || '0',
                basicPay: loan.basic_pay || '0',
                shareAmount: loan.share_amount || '0',
                currentBalance: (parseFloat(loan.regular_loan_balance || 0) + parseFloat(loan.emergency_loan_balance || 0)).toString(),

                surety1: loan.g1mbno || '0',
                surety1Name: loan.s1_name || '',
                surety1Office: loan.s1_office || '',
                surety1LoanBalance: loan.s1_loan_balance || '0',

                surety2: loan.g2mbno || '0',
                surety2Name: loan.s2_name || '',
                surety2Office: loan.s2_office || '',
                surety2LoanBalance: loan.s2_loan_balance || '0',

                surety3: loan.g3mbno || '0'
            };
        } catch (error) {
            this.logger.error(`Error getting loan details: ${error.message}`);
            throw error;
        }
    }

    /**
     * Update loan with sanction details
     */
    async updateLoanSanction(caseNo: string, sanctionData: any) {
        try {
            // Block sanction if loan already has a voucher or is paid/passed
            // Only check the active (unpaid) row — old completed rows with same case number are ignored
            const lockCheck = await this.dataSource.query(`
                SELECT lp.flg_paid, lp.flg_sanctioned, lp.applied_amt,
                    -- BUG FIX 29 (same as above): trailing '|' avoids matching a longer case number
                    -- that happens to start with this one's digits.
                    (SELECT COUNT(*) FROM vouchers WHERE remarks LIKE '%LOAN_CASE:' || $1 || '|%' AND status IN ('PENDING','POSTED')) as voucher_count
                FROM loan_pending lp
                WHERE lp.loancaseno::numeric = $1::numeric AND lp.flg_paid != 'Y'
                ORDER BY lp.app_date DESC LIMIT 1
            `, [caseNo]);
            if (lockCheck.length > 0 && parseInt(lockCheck[0].voucher_count) > 0) {
                throw new BadRequestException('Cannot modify sanction — voucher already generated for this loan');
            }
            if (lockCheck.length === 0) {
                throw new NotFoundException('Loan case not found');
            }

            // BUG FIX 33: nothing stopped a sanctioned amount from exceeding what was actually
            // applied for — an officer could sanction far more than the member ever requested,
            // with no check anywhere (frontend only validated the amount was positive).
            const appliedAmt = Number(lockCheck[0].applied_amt) || 0;
            const sanctionedAmt = Number(sanctionData.sanctionedAmount) || 0;
            if (sanctionedAmt <= 0) {
                throw new BadRequestException('Sanctioned amount must be greater than zero.');
            }
            if (sanctionedAmt > appliedAmt) {
                throw new BadRequestException(
                    `Sanctioned amount (₹${sanctionedAmt.toLocaleString('en-IN')}) cannot exceed the applied amount (₹${appliedAmt.toLocaleString('en-IN')}).`
                );
            }

            // rate/penalRate are optional per-case overrides — the sanctioning
            // officer can set a different rate for this particular loan instead
            // of whatever the rule master's default is for that loan type. Left
            // null when not supplied, so generateLoanVoucher falls back to the
            // rule master default at disbursement time.
            const rateOverride = sanctionData.rate !== undefined && sanctionData.rate !== null && sanctionData.rate !== ''
                ? parseFloat(sanctionData.rate) : null;
            const penalRateOverride = sanctionData.penalRate !== undefined && sanctionData.penalRate !== null && sanctionData.penalRate !== ''
                ? parseFloat(sanctionData.penalRate) : null;

            const updateQuery = `
        UPDATE loan_pending SET
          sanctioned_amt = $1,
          sanctioned_date = $2,
          no_of_instal = $3,
          rate = $5,
          penalrate = $6,
          flg_sanctioned = 'Y'
        WHERE loancaseno::numeric = $4::numeric AND flg_paid != 'Y'
        RETURNING *
      `;

            const result = await this.dataSource.query(updateQuery, [
                sanctionData.sanctionedAmount,
                parseSafeDate(sanctionData.sanctionDate),
                sanctionData.noOfInstallments,
                caseNo,
                rateOverride,
                penalRateOverride,
            ]);

            if (result.length === 0) {
                throw new NotFoundException('Loan case not found');
            }

            this.logger.log(`Loan ${caseNo} sanctioned successfully`);

            return {
                success: true,
                message: 'Loan sanctioned successfully',
                data: result[0]
            };
        } catch (error: any) {
            this.logger.error(`Error updating loan sanction: ${error.message}`);
            // BUG FIX 34: every rejection above (bad amount, already-vouchered, not found) was a
            // deliberate, typed exception — but this always re-wrapped it in a plain Error, which
            // NestJS defaults to HTTP 500. That's wrong for a rejected request; only a genuine
            // unexpected failure should be a 500.
            if (error instanceof BadRequestException || error instanceof NotFoundException) {
                throw error;
            }
            throw new Error('Failed to update loan sanction: ' + error.message);
        }
    }

    /**
     * Get loan account code based on loan type
     */
    getLoanAccountCode(loanType: string): string {
        // BUG FIX 26: ALN mapped to A1048 ("ELECTION ADVANCE" — unrelated to loans). Every real
        // loan record in this system uses loantype='ALN' exclusively (checked live: zero RLN/ELN
        // rows exist in loan_pending or loan_master), and A1047 itself carries headtype='ALN' in
        // the chart of accounts under the name "EMERGENCY LOAN" — both point at A1047, not A1048.
        const codeMapping: Record<string, string> = {
            'R': 'A1002',
            'REG': 'A1002',
            'RLN': 'A1002',
            'E': 'A1047',
            'EMR': 'A1047',
            'ELN': 'A1047',
            'A': 'A1047',
            'ALN': 'A1047'
        };
        return codeMapping[loanType?.toUpperCase()] || 'A1047';
    }
}
