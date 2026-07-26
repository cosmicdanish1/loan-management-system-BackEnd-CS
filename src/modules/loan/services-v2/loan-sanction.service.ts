import { Injectable, Logger } from '@nestjs/common';
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
              WHERE v.remarks LIKE '%LOAN_CASE:' || lp.loancaseno || '%'
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
          
          CASE 
            WHEN lp.loantype = 'R' OR lp.loantype = 'REG' OR lp.loantype = 'RLN' THEN 'REGULAR LOAN'
            WHEN lp.loantype = 'E' OR lp.loantype = 'EMR' OR lp.loantype = 'ELN' THEN 'EMERGENCY LOAN'
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
                SELECT lp.flg_paid, lp.flg_sanctioned,
                    (SELECT COUNT(*) FROM vouchers WHERE remarks LIKE '%LOAN_CASE:' || $1 || '%' AND status IN ('PENDING','POSTED')) as voucher_count
                FROM loan_pending lp
                WHERE lp.loancaseno::numeric = $1::numeric AND lp.flg_paid != 'Y'
                ORDER BY lp.app_date DESC LIMIT 1
            `, [caseNo]);
            if (lockCheck.length > 0 && parseInt(lockCheck[0].voucher_count) > 0) {
                throw new Error('Cannot modify sanction — voucher already generated for this loan');
            }

            const updateQuery = `
        UPDATE loan_pending SET
          sanctioned_amt = $1,
          sanctioned_date = $2,
          no_of_instal = $3,
          flg_sanctioned = 'Y'
        WHERE loancaseno::numeric = $4::numeric AND flg_paid != 'Y'
        RETURNING *
      `;

            const result = await this.dataSource.query(updateQuery, [
                sanctionData.sanctionedAmount,
                parseSafeDate(sanctionData.sanctionDate),
                sanctionData.noOfInstallments,
                caseNo
            ]);

            if (result.length === 0) {
                throw new Error('Loan case not found');
            }

            this.logger.log(`Loan ${caseNo} sanctioned successfully`);

            return {
                success: true,
                message: 'Loan sanctioned successfully',
                data: result[0]
            };
        } catch (error: any) {
            this.logger.error(`Error updating loan sanction: ${error.message}`);
            throw new Error('Failed to update loan sanction: ' + error.message);
        }
    }

    /**
     * Get loan account code based on loan type
     */
    getLoanAccountCode(loanType: string): string {
        const codeMapping: Record<string, string> = {
            'R': 'A1002',
            'REG': 'A1002',
            'RLN': 'A1002',
            'E': 'A1047',
            'EMR': 'A1047',
            'ELN': 'A1047',
            'A': 'A1048',
            'ALN': 'A1048'
        };
        return codeMapping[loanType?.toUpperCase()] || 'A1047';
    }
}
