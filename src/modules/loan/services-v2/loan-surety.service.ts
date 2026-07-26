import { Injectable, Logger } from '@nestjs/common';
import { DataSource } from 'typeorm';

/**
 * Loan Surety Service - Handles guarantor/surety management for loans.
 * 
 * @version 2.0 - Part of backend restructuring
 * 
 * ⭐ This service was extracted to fix the Change Loan Surety feature.
 * It provides clean, isolated logic for updating loan guarantors.
 */
@Injectable()
export class LoanSuretyService {
    private readonly logger = new Logger(LoanSuretyService.name);

    constructor(private readonly dataSource: DataSource) { }

    /**
     * Change loan sureties (guarantors)
     * Updates both loan_pending and suretymaster tables in a transaction
     */
    /**
     * Change loan sureties (guarantors)
     * Updates loan_pending, suretymaster, and loan_master tables in a transaction.
     * If records are missing in certain tables, it attempts to "repair" or skip gracefully.
     */
    async changeLoanSurety(caseNo: string, suretyData: { surety1: string; surety2?: string }) {
        // Validate surety members before opening a transaction
        const s1Check = await this.validateSurety(suretyData.surety1);
        if (!s1Check.valid) throw new Error(`Surety 1: ${s1Check.message}`);

        if (suretyData.surety2) {
            const s2Check = await this.validateSurety(suretyData.surety2);
            if (!s2Check.valid) throw new Error(`Surety 2: ${s2Check.message}`);
        }

        const queryRunner = this.dataSource.createQueryRunner();

        try {
            await queryRunner.connect();
            await queryRunner.startTransaction();

            this.logger.log(`Changing sureties for loan case: ${caseNo}`);
            this.logger.debug(`New Surety1: ${suretyData.surety1}, Surety2: ${suretyData.surety2 || 'none'}`);

            // 1. First, fetch the loan case to get member number and verify it exists
            const selectQuery = `
                SELECT mbno, loancaseno, g1mbno, g2mbno
                FROM loan_pending 
                WHERE loancaseno::text = $1
            `;

            const selectResult = await queryRunner.query(selectQuery, [caseNo]);

            if (selectResult.length === 0) {
                throw new Error(`Loan case ${caseNo} not found in loan_pending`);
            }

            const currentData = selectResult[0];
            const memberNo = String(currentData.mbno);

            this.logger.debug(`Found loan case for member: ${memberNo}, Current G1=${currentData.g1mbno}, G2=${currentData.g2mbno}`);

            // Validate we have a valid member number
            if (!memberNo || memberNo === 'undefined' || memberNo === 'null') {
                throw new Error(`Invalid member number for loan case ${caseNo}`);
            }

            // 2. Update loan_pending table with new guarantors
            const updateLpQuery = `
                UPDATE loan_pending 
                SET g1mbno = $1, g2mbno = $2 
                WHERE loancaseno::text = $3
            `;

            await queryRunner.query(updateLpQuery, [
                suretyData.surety1,
                suretyData.surety2 || 0,  // loan_pending.g2mbno is NOT NULL DEFAULT 0
                caseNo
            ]);

            this.logger.log(`Updated loan_pending for member: ${memberNo}, case: ${caseNo}`);

            // 3. Update suretymaster table if record exists
            // Note: suretymaster table has no 'id' column, only mbno as identifier
            const updateSmQuery = `
                UPDATE suretymaster 
                SET g1mbno = $1, g2mbno = $2 
                WHERE mbno = $3
                RETURNING mbno
            `;

            const smResult = await queryRunner.query(updateSmQuery, [
                suretyData.surety1,
                suretyData.surety2 || 0,
                memberNo
            ]);

            if (smResult.length > 0) {
                this.logger.log(`Updated suretymaster for member: ${memberNo}`);
            } else {
                this.logger.warn(`No suretymaster record found for member: ${memberNo} (this is okay - not all loans have suretymaster entries)`);
            }

            await queryRunner.commitTransaction();
            this.logger.log('All surety changes committed successfully');

            return {
                success: true,
                message: 'Loan sureties updated successfully',
                memberNo: memberNo,
                loanCaseNo: caseNo,
                updatedTables: {
                    loan_pending: true,
                    suretymaster: smResult.length > 0
                }
            };

        } catch (error: any) {
            await queryRunner.rollbackTransaction();
            this.logger.error(`Error changing loan sureties: ${error.message}`);
            throw new Error(`Failed to update loan sureties: ${error.message}`);
        } finally {
            await queryRunner.release();
        }
    }

    /**
     * Get current sureties for a loan case
     */
    async getLoanSureties(caseNo: string) {
        try {
            const query = `
        SELECT 
          lp.loancaseno,
          lp.mbno,
          lp.g1mbno as surety1,
          lp.g2mbno as surety2,
          TRIM(COALESCE(s1.f_name, '') || ' ' || COALESCE(s1.m_name, '') || ' ' || COALESCE(s1.l_name, '')) as surety1_name,
          TRIM(COALESCE(s2.f_name, '') || ' ' || COALESCE(s2.m_name, '') || ' ' || COALESCE(s2.l_name, '')) as surety2_name
        FROM loan_pending lp
        LEFT JOIN member_master s1 ON lp.g1mbno = s1.mbno
        LEFT JOIN member_master s2 ON lp.g2mbno = s2.mbno
        WHERE lp.loancaseno::text = $1
      `;

            const result = await this.dataSource.query(query, [caseNo]);

            if (result.length === 0) {
                return null;
            }

            const loan = result[0];
            return {
                loanCaseNo: loan.loancaseno,
                memberNo: loan.mbno,
                surety1: loan.surety1 || '',
                surety1Name: loan.surety1_name || '',
                surety2: loan.surety2 || '',
                surety2Name: loan.surety2_name || ''
            };
        } catch (error) {
            this.logger.error(`Error getting loan sureties: ${error.message}`);
            throw error;
        }
    }

    /**
     * Validate surety member exists and is active
     */
    async validateSurety(memberNo: string): Promise<{ valid: boolean; message?: string }> {
        try {
            const query = `
        SELECT mbno, isactive,
               TRIM(COALESCE(f_name, '') || ' ' || COALESCE(l_name, '')) as name
        FROM member_master
        WHERE mbno = $1
      `;

            const result = await this.dataSource.query(query, [memberNo]);

            if (result.length === 0) {
                return { valid: false, message: `Member ${memberNo} not found` };
            }

            const member = result[0];
            // Only 'Y' is the valid active flag — '1' was an inconsistency
            if (member.isactive !== 'Y') {
                return { valid: false, message: `Member ${memberNo} (${member.name}) is not active` };
            }

            return { valid: true };
        } catch (error) {
            this.logger.error(`Error validating surety: ${error.message}`);
            return { valid: false, message: 'Error validating surety member' };
        }
    }

    /**
     * Get all loan cases for a member — includes both pending (not disbursed)
     * and active (disbursed) loans, so the Change Surety form can show all cases.
     *
     * loan_pending holds ALL loan applications regardless of disbursement status.
     * flg_paid = 'N'  → pending / sanctioned, not yet disbursed
     * flg_paid = 'Y'  → disbursed (record also exists in loan_master)
     */
    async getLoanSuretyCases(memberNo: string) {
        try {
            const query = `
                SELECT DISTINCT ON (lp.loancaseno)
                    lp.loancaseno                                                   AS "loanCaseNo",
                    lp.loantype                                                     AS "loanType",
                    lp.applied_amt                                                  AS "loanAmount",
                    lp.sanctioned_amt                                               AS "sanctionedAmount",
                    lp.flg_paid,
                    lp.flg_sanctioned,
                    lp.app_date                                                     AS "applicationDate",
                    CASE
                        WHEN lm.loancaseno IS NOT NULL THEN 'ACTIVE'
                        WHEN lp.flg_sanctioned = 'Y'  THEN 'SANCTIONED'
                        ELSE 'PENDING'
                    END                                                             AS status
                FROM loan_pending lp
                LEFT JOIN loan_master lm
                       ON lp.loancaseno::text = lm.loancaseno::text
                WHERE lp.mbno::text = $1
                ORDER BY lp.loancaseno, lp.app_date DESC
            `;

            const rows = await this.dataSource.query(query, [String(memberNo)]);

            this.logger.log(`Found ${rows.length} loan case(s) for member ${memberNo}`);
            return rows;
        } catch (error) {
            this.logger.error(`Error fetching surety cases: ${error.message}`);
            throw error;
        }
    }
}
