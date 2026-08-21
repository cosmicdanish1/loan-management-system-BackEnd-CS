import { Injectable, Logger, BadRequestException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { SequenceGeneratorService } from '../../shared/services';
import { SystemConfigService } from '../../admin/services/system-config.service';
import { LoanEligibilityService } from './loan-eligibility.service';
import { LoanSuretyService } from './loan-surety.service';
import { autoQueueNotification } from '../../shared/utils/auto-notify';

/**
 * Loan Application Service - Handles loan applications and case management.
 * 
 * @version 2.0 - Part of backend restructuring
 * Extracted from member.service.ts for single responsibility
 */
@Injectable()
export class LoanApplicationService {
    private readonly logger = new Logger(LoanApplicationService.name);

    constructor(
        private readonly dataSource: DataSource,
        private readonly sequenceGenerator: SequenceGeneratorService,
        private readonly systemConfigService: SystemConfigService,
        private readonly loanEligibilityService: LoanEligibilityService,
        private readonly loanSuretyService: LoanSuretyService,
    ) { }

    /**
     * Generate next sequential loan case number
     */
    async generateNextLoanCaseNo(): Promise<string> {
        return this.sequenceGenerator.generateNextLoanCaseNo();
    }

    /**
     * Get editable (pending / unsanctioned) loan cases for a member.
     * Only returns loan_pending rows that have not yet been paid/disbursed.
     * These are the only ones the Loan Application form can sensibly edit.
     */
    async getMemberLoanCases(memberNo: string) {
        try {
            const query = `
        SELECT DISTINCT ON (loancaseno)
          loancaseno,
          loantype,
          applied_amt::numeric  AS loan_amt,
          0::numeric            AS balance,
          purpose,
          flg_sanctioned,
          flg_paid
        FROM loan_pending
        WHERE mbno = $1
          AND flg_paid = 'N'
        ORDER BY loancaseno DESC
      `;

            const loanCases = await this.dataSource.query(query, [memberNo]);

            this.logger.log(`Found ${loanCases.length} editable pending cases for member ${memberNo}`);

            return loanCases.map((loan: any) => ({
                memberNo,
                loanCaseNo: loan.loancaseno,
                loanType: loan.loantype,
                loanAmount: loan.loan_amt,
                balance: loan.balance,
                purpose: loan.purpose,
                sanctioned: loan.flg_sanctioned === 'Y',
            }));
        } catch (error) {
            this.logger.error(`Error getting member loan cases: ${error.message}`);
            return [];
        }
    }

    /**
     * Save loan application — INSERT new case or UPDATE existing one.
     * Runs inside a single DB transaction so sequence + loan_pending + suretymaster
     * are committed atomically or rolled back together.
     */
    async saveLoanApplication(loanData: any) {
        this.logger.log(`Saving loan application for member: ${loanData.memberNo}`);

        // --- 1. Eligibility check (outside transaction — read-only) ---
        const amount = parseFloat(loanData.loanAmount || loanData.appliedAmount || 0);
        // BUG FIX 27: nothing rejected a zero or negative loan amount — it would pass every
        // downstream check (trivially under any max limit) and create a real loan_pending row.
        if (!amount || amount <= 0) {
            throw new BadRequestException('Loan amount must be greater than zero.');
        }
        const installments = loanData.noOfInstallments || 60;
        await this.validateLoanEligibility(loanData.memberNo, amount, installments, loanData.loanType);

        // --- 1b. Share Value & FD Eligibility rule check ---
        await this.loanEligibilityService.enforceEligibility(loanData.memberNo, amount);

        // --- 2. Loan type normalisation ---
        const loanTypeMapping: Record<string, string> = {
            'EMERGENCY': 'ELN', 'EMERGENCY LOAN': 'ELN', 'Emergency': 'ELN', 'ELN': 'ELN',
            'REGULAR': 'RLN', 'REGULAR LOAN': 'RLN', 'Regular': 'RLN', 'RLN': 'RLN',
            'ADDITIONAL': 'ALN', 'ADDITIONAL LOAN': 'ALN', 'Additional': 'ALN', 'ALN': 'ALN',
        };
        const lookupKey = (loanData.loanType || '').toString();
        const mappedLoanType = loanTypeMapping[lookupKey]
            || loanTypeMapping[lookupKey.toUpperCase()]
            || lookupKey.substring(0, 3).toUpperCase();

        // --- 3. Sanitise fields ---
        // purpose is VARCHAR(50); form_number is VARCHAR(10)
        const purpose = (loanData.reason || loanData.purpose || '').slice(0, 50);
        const formNumber = (loanData.formNumber || '0').slice(0, 10);
        // Use the user-selected application date, fall back to today
        const appDate = loanData.applDate ? new Date(loanData.applDate) : new Date();
        // g1/g2 must be numeric — use 0 instead of NULL (column default is 0, not nullable)
        const g1mbno = loanData.surety1 || 0;
        const g2mbno = loanData.surety2 || 0;

        // Regular loan (RLN) requires at least 1 surety
        if (mappedLoanType === 'RLN' && !g1mbno) {
            throw new Error('Regular Loan requires at least 1 surety/security member');
        }

        // BUG FIX 28: surety members were never checked to exist or be active — the exact
        // validation for this already exists and is proven working in LoanSuretyService
        // (used by Change Loan Surety), just never called from here.
        if (g1mbno) {
            const s1Check = await this.loanSuretyService.validateSurety(String(g1mbno));
            if (!s1Check.valid) throw new BadRequestException(`Surety 1: ${s1Check.message}`);
        }
        if (g2mbno) {
            const s2Check = await this.loanSuretyService.validateSurety(String(g2mbno));
            if (!s2Check.valid) throw new BadRequestException(`Surety 2: ${s2Check.message}`);
        }

        // --- 4. Sequence generation (before transaction so gaps are predictable) ---
        let loanCaseNo = loanData.loanCaseNo;
        if (!loanCaseNo) {
            loanCaseNo = await this.sequenceGenerator.generateNextLoanCaseNo();
        }

        // --- 5. Transactional writes ---
        const queryRunner = this.dataSource.createQueryRunner();
        await queryRunner.connect();
        await queryRunner.startTransaction();

        try {
            // Decide INSERT vs UPDATE based on whether this case already exists in loan_pending
            const existing = await queryRunner.query(
                `SELECT loancaseno FROM loan_pending WHERE loancaseno::text = $1`,
                [String(loanCaseNo)]
            );
            const isUpdate = existing.length > 0;

            let result: any[];
            if (isUpdate) {
                this.logger.log(`Updating existing loan_pending case: ${loanCaseNo}`);
                result = await queryRunner.query(`
                    UPDATE loan_pending SET
                        loantype    = $1,
                        applied_amt = $2,
                        app_date    = $3,
                        no_of_instal = $4,
                        purpose     = $5,
                        form_number = $6,
                        g1mbno      = $7,
                        g2mbno      = $8
                    WHERE loancaseno::text = $9
                    RETURNING *
                `, [mappedLoanType, amount, appDate, installments, purpose, formNumber,
                    g1mbno, g2mbno, String(loanCaseNo)]);
            } else {
                this.logger.log(`Inserting new loan_pending case: ${loanCaseNo}`);
                result = await queryRunner.query(`
                    INSERT INTO loan_pending (
                        mbno, loantype, loancaseno, applied_amt, sanctioned_amt, app_date,
                        no_of_instal, purpose, flg_sanctioned, flg_paid, form_number, g1mbno, g2mbno
                    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
                    RETURNING *
                `, [loanData.memberNo, mappedLoanType, loanCaseNo, amount,
                    0, appDate, installments, purpose, 'N', 'N', formNumber, g1mbno, g2mbno]);
            }

            // Sync suretymaster (UPSERT) whenever guarantors are provided
            if (g1mbno || g2mbno) {
                const sm = await queryRunner.query(
                    `SELECT mbno FROM suretymaster WHERE mbno = $1`, [loanData.memberNo]
                );
                if (sm.length > 0) {
                    await queryRunner.query(
                        `UPDATE suretymaster SET g1mbno = $1, g2mbno = $2 WHERE mbno = $3`,
                        [g1mbno, g2mbno, loanData.memberNo]
                    );
                    this.logger.log(`Updated suretymaster for member: ${loanData.memberNo}`);
                } else {
                    await queryRunner.query(
                        `INSERT INTO suretymaster (mbno, amount, g1mbno, g2mbno, g1amt, g2amt, addflag)
                         VALUES ($1, 0, $2, $3, 0, 0, 'N')`,
                        [loanData.memberNo, g1mbno, g2mbno]
                    );
                    this.logger.log(`Inserted suretymaster for member: ${loanData.memberNo}`);
                }
            }

            // Save nominees — always replace existing rows for this case
            const nominees: any[] = Array.isArray(loanData.nominees) ? loanData.nominees : [];
            const validNominees = nominees.filter((n: any) => n.name && n.name.trim());
            if (validNominees.length > 0) {
                await queryRunner.query(
                    `DELETE FROM loan_nominee WHERE loancaseno = $1`, [String(loanCaseNo)]
                );
                for (let i = 0; i < validNominees.length; i++) {
                    const n = validNominees[i];
                    await queryRunner.query(
                        `INSERT INTO loan_nominee (srno, loancaseno, name, address, age, relation)
                         VALUES ($1, $2, $3, $4, $5, $6)`,
                        [i + 1, String(loanCaseNo),
                         (n.name || '').slice(0, 50),
                         (n.address || '').slice(0, 50),
                         parseInt(n.age, 10) || null,   // smallint — must be integer or NULL
                         (n.relation || '').slice(0, 25)]
                    );
                }
                this.logger.log(`Saved ${validNominees.length} nominee(s) for case: ${loanCaseNo}`);
            }

            // Save FDR/Loan-Against-Deposit rows — replace existing
            const fdrRows: any[] = Array.isArray(loanData.fdrDetails) ? loanData.fdrDetails : [];
            const validFdr = fdrRows.filter((f: any) => f.fdrNo && f.fdrNo.trim());
            if (validFdr.length > 0) {
                await queryRunner.query(
                    `DELETE FROM loan_fdr WHERE loancaseno = $1`, [String(loanCaseNo)]
                );
                for (const f of validFdr) {
                    await queryRunner.query(
                        `INSERT INTO loan_fdr
                            (loancaseno, srno, fdr_no, account_no, dep_date, period, unit,
                             rate, amount, mat_amount, lien,
                             mat_date, last_intt_date, intt_paid)
                         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
                        [String(loanCaseNo),
                         parseInt(f.srno, 10) || null,
                         (f.fdrNo || '').slice(0, 30),
                         (f.accountNo || '').slice(0, 30),
                         f.depDate ? new Date(f.depDate) : null,
                         (f.period || '').slice(0, 20),
                         (f.unit || '').slice(0, 10),
                         parseFloat(f.rate) || 0,
                         parseFloat(f.amount) || 0,
                         parseFloat(f.matAmount) || 0,
                         f.lien === true || f.lien === 'true',
                         f.matDate ? new Date(f.matDate) : null,
                         f.lastIntt ? new Date(f.lastIntt) : null,
                         parseFloat(f.inttPaid) || 0]
                    );
                }
                this.logger.log(`Saved ${validFdr.length} FDR row(s) for case: ${loanCaseNo}`);
            }

            await queryRunner.commitTransaction();
            this.logger.log(`Loan application ${isUpdate ? 'updated' : 'saved'}. Case No: ${loanCaseNo}`);

            // Auto-queue notification
            if (!isUpdate) {
                autoQueueNotification(this.dataSource, String(loanData.memberNo),
                    `Your loan application #${loanCaseNo} for ₹${amount.toLocaleString('en-IN')} (${mappedLoanType}) has been submitted. Pending sanction. — FIBE Credit Society`,
                    'LOAN_APPLICATION'
                ).catch(() => {});
            }

            return {
                success: true,
                message: isUpdate ? 'Loan application updated successfully' : 'Loan application saved successfully',
                loanCaseNo,
                nomineesSaved: validNominees.length,
                fdrRowsSaved: validFdr.length,
                data: result[0],
            };
        } catch (error: any) {
            await queryRunner.rollbackTransaction();
            this.logger.error(`Transaction rolled back: ${error.message}`);
            throw new Error('Failed to save loan application: ' + error.message);
        } finally {
            await queryRunner.release();
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
            this.logger.error(`Error getting loan cases: ${error.message}`);
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
            this.logger.error(`Error getting member pending loans: ${error.message}`);
            return [];
        }
    }

    /**
     * Validate loan eligibility (Dynamic Business Rules)
     */
    private async validateLoanEligibility(memberNo: string, amount: number, installments: number, loanType: string): Promise<void> {
        this.logger.log(`Validating eligibility for ${loanType} loan...`);

        // 1. Determine which rules to use based on loan type
        // ALN = Emergency Loan, RLN = Regular Loan, ELN = Loan Against Recovery
        const isEmergency = (loanType === 'ALN' || loanType === 'ELN');
        const typePrefix  = isEmergency ? 'EL' : 'LT';
        const maxAmtKey    = `RULE_LOAN_${typePrefix}_MAX_AMT`;
        const maxTenureKey = `RULE_LOAN_${typePrefix}_MAX_TENURE`;

        // 2. Fetch configured limits (generous defaults so a missing key never hard-blocks)
        const maxLoanLimit = await this.systemConfigService.getConfigValue(maxAmtKey).catch(() => isEmergency ? 500000 : 1000000);
        const maxTenure = await this.systemConfigService.getConfigValue(maxTenureKey).catch(() => isEmergency ? 60 : 120);

        // 3. Check outstanding balance from member_balances (kept current by repayment processing)
        //    Do NOT use loan_master.balance — it is set once at disbursement and never reduced.
        const balanceCol = isEmergency ? 'emergency_loan_balance' : 'regularloan';
        const query = `
          SELECT COALESCE(${balanceCol}::numeric, 0) as total
          FROM member_balances
          WHERE mbno = $1
        `;

        const result = await this.dataSource.query(query, [memberNo]);
        const totalOutstanding = Number(result[0]?.total || 0);

        this.logger.debug(`Loan type: ${loanType}, Balance column: ${balanceCol}`);
        this.logger.debug(`Current outstanding: ${totalOutstanding}, Applied: ${amount}, Total: ${totalOutstanding + amount}, Max: ${maxLoanLimit}`);

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

        this.logger.log(`Eligibility check passed for member ${memberNo}`);
    }

    async getMemberBalances(memberNo: string): Promise<{
        regularLoanBal: number;
        emergencyLoanBal: number;
        shareBalance: number;
    }> {
        try {
            const rows = await this.dataSource.query(
                `SELECT
                   COALESCE(regularloan::numeric, 0)            AS regular_loan_bal,
                   COALESCE(emergency_loan_balance::numeric, 0)  AS emergency_loan_bal
                 FROM member_balances
                 WHERE mbno = $1`,
                [memberNo]
            );
            const row = rows[0] || {};
            return {
                regularLoanBal: Number(row.regular_loan_bal || 0),
                emergencyLoanBal: Number(row.emergency_loan_bal || 0),
                shareBalance: 0,
            };
        } catch (error) {
            this.logger.error(`getMemberBalances error: ${error.message}`);
            return { regularLoanBal: 0, emergencyLoanBal: 0, shareBalance: 0 };
        }
    }
}
