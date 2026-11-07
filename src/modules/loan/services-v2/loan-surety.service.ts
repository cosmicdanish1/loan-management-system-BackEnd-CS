import { BadRequestException, HttpException, Injectable, NotFoundException } from '@nestjs/common';
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
        // ES-371: the case is looked up first, so an unknown case is a 404 and not a complaint about the surety member
        const caseRows = await this.dataSource.query(
            `SELECT mbno FROM loan_pending WHERE loancaseno::text = $1`,
            [caseNo],
        );
        if (!caseRows || caseRows.length === 0) throw new NotFoundException(`Loan case ${caseNo} not found`);

        // Validate surety members before opening a transaction (a bad surety is a 400)
        const s1Check = await this.validateSurety(suretyData.surety1);
        if (!s1Check.valid) throw new BadRequestException(`Surety 1: ${s1Check.message}`);

        if (suretyData.surety2) {
            const s2Check = await this.validateSurety(suretyData.surety2);
            if (!s2Check.valid) throw new BadRequestException(`Surety 2: ${s2Check.message}`);
        }

        // ES-405: the two sureties must be different members
        const isSurety = (v: any) => String(v ?? '').trim() !== '' && String(v).trim() !== '0';
        if (isSurety(suretyData.surety1) && isSurety(suretyData.surety2) && String(suretyData.surety1).trim() === String(suretyData.surety2).trim()) {
            throw new BadRequestException('The same member cannot be both sureties.');
        }

        const queryRunner = this.dataSource.createQueryRunner();
        let started = false; // rollback only a transaction that really began (a failed connect must not call it)

        try {
            await queryRunner.connect();
            await queryRunner.startTransaction();
            started = true;

            console.log(`[LoanSurety] 🔄 Changing sureties for loan case: ${caseNo}`);
            console.log(`[LoanSurety] New Surety1: ${suretyData.surety1}, Surety2: ${suretyData.surety2 || 'none'}`);

            // 1. First, fetch the loan case to get member number and verify it exists
            const selectQuery = `
                SELECT mbno, loancaseno, g1mbno, g2mbno, flg_paid,
                       EXISTS (SELECT 1 FROM loan_master lm WHERE lm.loancaseno::text = loan_pending.loancaseno::text AND lm.mbno = loan_pending.mbno) AS disbursed
                FROM loan_pending
                WHERE loancaseno::text = $1
                FOR UPDATE
            `;

            const selectResult = await queryRunner.query(selectQuery, [caseNo]);

            if (selectResult.length === 0) {
                throw new NotFoundException(`Loan case ${caseNo} not found in loan_pending`);
            }

            const currentData = selectResult[0];
            const memberNo = String(currentData.mbno);

            console.log(`[LoanSurety] Found loan case for member: ${memberNo}`);
            console.log(`[LoanSurety] Current guarantors: G1=${currentData.g1mbno}, G2=${currentData.g2mbno}`);

            // Validate we have a valid member number
            if (!memberNo || memberNo === 'undefined' || memberNo === 'null') {
                throw new Error(`Invalid member number for loan case ${caseNo}`);
            }

            // ES-405: a member can not stand surety for his own loan
            for (const sur of [suretyData.surety1, suretyData.surety2]) {
                if (isSurety(sur) && String(sur).trim() === memberNo.trim()) {
                    throw new BadRequestException('A member cannot stand surety for his own loan.');
                }
            }
            // ES-405: once the loan is paid out the live loan keeps its sureties; changing only loan_pending would
            // silently leave the two out of step
            if (currentData.flg_paid === 'Y' || currentData.disbursed === true) {
                throw new BadRequestException(`Loan case ${caseNo} is already disbursed, so its sureties cannot be changed here.`);
            }

            // 2. Update loan_pending table with new guarantors
            const updateLpQuery = `
                UPDATE loan_pending 
                SET g1mbno = $1, g2mbno = $2 
                WHERE loancaseno::text = $3
            `;

            await queryRunner.query(updateLpQuery, [
                suretyData.surety1,
                suretyData.surety2 || null,
                caseNo
            ]);

            console.log(`[LoanSurety] ✅ Updated loan_pending for member: ${memberNo}, case: ${caseNo}`);
            console.log(`[LoanSurety] New guarantors: G1=${suretyData.surety1}, G2=${suretyData.surety2 || '0'}`);

            // 3. Update suretymaster table if record exists
            // Note: suretymaster table has no 'id' column, only mbno as identifier
            // by case: the member's other loans keep their own sureties (ES-405)
            const updateSmQuery = `
                UPDATE suretymaster 
                SET g1mbno = $1, g2mbno = $2 
                WHERE mbno = $3 AND loancaseno::text = $4
                RETURNING mbno
            `;

            const smResult = await queryRunner.query(updateSmQuery, [
                suretyData.surety1,
                suretyData.surety2 || null,
                memberNo,
                caseNo
            ]);

            if (smResult.length > 0) {
                console.log(`[LoanSurety] ✅ Updated suretymaster for member: ${memberNo}`);
            } else {
                console.log(`[LoanSurety] ⚠️ No suretymaster record found for member: ${memberNo} (this is okay - not all loans have suretymaster entries)`);
            }

            await queryRunner.commitTransaction();
            console.log(`[LoanSurety] ✅ All surety changes committed successfully`);

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
            if (started) await queryRunner.rollbackTransaction();
            console.error(`[LoanSurety] ❌ Error changing loan sureties:`, error);
            if (error instanceof HttpException) throw error;
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
          REGEXP_REPLACE(TRIM(COALESCE(s1.f_name, '') || ' ' || COALESCE(s1.m_name, '') || ' ' || COALESCE(s1.l_name, '')), '\\s+', ' ', 'g') as surety1_name,
          REGEXP_REPLACE(TRIM(COALESCE(s2.f_name, '') || ' ' || COALESCE(s2.m_name, '') || ' ' || COALESCE(s2.l_name, '')), '\\s+', ' ', 'g') as surety2_name
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
            console.error('[LoanSurety] Error getting loan sureties:', error);
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
            // a database failure is an error, not "invalid member" (ES-405)
            console.error('[LoanSurety] Error validating surety:', error);
            throw error;
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

            console.log(`[LoanSurety] Found ${rows.length} loan case(s) for member ${memberNo}`);
            return rows;
        } catch (error) {
            console.error('[LoanSurety] Error fetching surety cases:', error);
            throw error;
        }
    }
}
