import { BadRequestException, HttpException, Injectable, Optional } from '@nestjs/common';
import { SystemConfigService } from '../../admin/services/system-config.service';
import { MAX_OVERRIDE_PERCENT, RateDefaults, resolveLoanRateDefaults } from './loan-rate-defaults.util';
import { DataSource } from 'typeorm';
import { parseSafeDate } from '../../shared/utils/date-utils';
import { LoanReagreementService } from './reagreement/loan-reagreement.service';
import { calculateConstantEmi, DEFAULT_SLOT1_END_DAY, DEFAULT_SLOT1_START_DAY, LoanRoundingMode } from './loan-rb-schedule.util';

/**
 * Loan Sanction Service - Handles loan sanction and approval operations.
 * 
 * @version 2.0 - Part of backend restructuring
 * Extracted from member.service.ts for single responsibility
 */
@Injectable()
export class LoanSanctionService {
    constructor(
        private readonly dataSource: DataSource,
        private readonly reagreementService: LoanReagreementService,
        @Optional() private readonly systemConfigService?: SystemConfigService,
    ) { }

    /** ES-506: the interest / penal rate a loan of this type gets from Business Rules when nobody overrides it. */
    async getRateDefaults(loanType: string): Promise<RateDefaults> {
        let systemRate: number | undefined;
        try {
            const key = (loanType === 'R' || loanType === 'REG' || String(loanType).toUpperCase() === 'RLN') ? 'RULE_LOAN_LT_INTEREST_RATE' : 'RULE_LOAN_EL_INTEREST_RATE';
            systemRate = Number(await this.systemConfigService?.getConfigValue(key));
        } catch { /* the card or the 12% fallback is used */ }
        return resolveLoanRateDefaults(this.dataSource, loanType, systemRate);
    }

    /**
     * ES-506: the real monthly installment and total interest a loan will have, calculated exactly like Pass Transaction
     * does at payout (same slot / delay / rounding rules), so the Sanction screen shows what the member will really pay.
     * `rate` is optional: without it the Business Rules rate for the loan type is used.
     */
    async previewSanction(caseNo: string, sanctionedAmount: unknown, noOfInstallments: unknown, rate?: unknown) {
        const amount = Number(sanctionedAmount);
        const n = Number(noOfInstallments);
        if (!Number.isFinite(amount) || amount <= 0 || amount > 999_999_999.99) throw new BadRequestException('Sanctioned amount must be a number greater than 0.');
        if (!Number.isInteger(n) || n <= 0 || n > 600) throw new BadRequestException('Number of installments must be a whole number greater than 0.');
        const rows = await this.dataSource.query(
            `SELECT loantype, app_date FROM loan_pending WHERE loancaseno::numeric = $1::numeric LIMIT 1`, [caseNo],
        );
        if (!rows.length) throw new BadRequestException('Loan case not found');
        const defaults = await this.getRateDefaults(String(rows[0].loantype ?? ''));
        let useRate = defaults.rate;
        if (rate !== undefined && rate !== null && rate !== '') {
            const r = Number(rate);
            if (!Number.isFinite(r) || r <= 0 || r > MAX_OVERRIDE_PERCENT) throw new BadRequestException(`Interest rate must be a number above 0 up to ${MAX_OVERRIDE_PERCENT}.`);
            useRate = r;
        }
        const cfg = async <T>(key: string, fallback: T): Promise<T> => {
            try { const v = await this.systemConfigService?.getConfigValue(key); return (v === undefined || v === null || v === '' ? fallback : v) as T; } catch { return fallback; }
        };
        const slot1Delay = Number(await cfg('RULE_LOAN_SLOT1_DELAY_MONTHS', 1));
        const slot2Delay = Number(await cfg('RULE_LOAN_SLOT2_DELAY_MONTHS', 2));
        const slot1Start = Number(await cfg('RULE_LOAN_SLOT1_START_DAY', DEFAULT_SLOT1_START_DAY));
        const slot1End = Number(await cfg('RULE_LOAN_SLOT1_END_DAY', DEFAULT_SLOT1_END_DAY));
        const configuredRounding = await cfg<string>('RULE_LOAN_ROUNDING_MODE', 'NEAREST');
        const rounding: LoanRoundingMode = (['NONE', 'NEAREST', 'UP', 'DOWN'].includes(configuredRounding) ? configuredRounding : 'NEAREST') as LoanRoundingMode;
        const appDate = rows[0].app_date ? new Date(rows[0].app_date) : new Date();
        const calc = calculateConstantEmi(amount, useRate, n, appDate, slot1Delay, slot2Delay, rounding, slot1Start, slot1End);
        return {
            rate: useRate,
            defaultRate: defaults.rate,
            monthlyPrincipal: calc.monthlyPrincipal,
            monthlyInterest: calc.monthlyInterestForEMI,
            monthlyInstallment: calc.constantEMI,
            totalInterest: calc.totalInterestForEMI,
        };
    }

    /**
     * ES-506: Business Rules supply every rate by default. The officer may give ONE customer a different interest or penal
     * rate at sanction: only values that differ from the default are kept (the other stays NULL = Business Rules), and a
     * reason is required. Values outside 0..MAX are refused.
     */
    private readRateOverride(data: any, defaults: RateDefaults) {
        const read = (raw: any, label: string, min: number, minInclusive: boolean) => {
            if (raw === undefined || raw === null || raw === '') return null;
            const n = Number(raw);
            if (!Number.isFinite(n) || (minInclusive ? n < min : n <= min) || n > MAX_OVERRIDE_PERCENT) {
                throw new BadRequestException(`${label} must be a number ${minInclusive ? 'from' : 'above'} ${min} up to ${MAX_OVERRIDE_PERCENT}.`);
            }
            return n;
        };
        const rateIn = read(data.rate, 'Interest rate', 0, false);
        const penalIn = read(data.penalRate, 'Penalty rate', 0, true);
        const rate = rateIn !== null && Math.abs(rateIn - defaults.rate) > 0.0001 ? rateIn : null;
        const penalRate = penalIn !== null && Math.abs(penalIn - defaults.penalRate) > 0.0001 ? penalIn : null;
        if (rate === null && penalRate === null) return { rate: null, penalRate: null, reason: null };
        const reason = String(data.rateOverrideReason ?? '').trim();
        if (!reason) throw new BadRequestException('Give a reason when the interest or penalty rate differs from Business Rules for this customer.');
        if (reason.length > 200) throw new BadRequestException('The reason for the rate change can be at most 200 characters.');
        return { rate, penalRate, reason };
    }

    /**
     * Get all sanctioned loan cases ready for disbursement
     */
    async getSanctionedLoanCases() {
        try {
            const query = `
        SELECT DISTINCT ON (lp.loancaseno)
          lp.loancaseno,
          lp.mbno,
          REGEXP_REPLACE(TRIM(COALESCE(mm.f_name, '') || ' ' || COALESCE(mm.m_name, '') || ' ' || COALESCE(mm.l_name, '')), '\\s+', ' ', 'g') as member_name,
          lp.loantype,
          lp.applied_amt,
          lp.sanctioned_amt,
          lp.flg_sanctioned,
          lp.flg_paid,
          lp.application_kind,
          lp.reagreement_id,
          lp.app_date as application_date
        FROM loan_pending lp
        JOIN member_master mm ON lp.mbno = mm.mbno
        WHERE lp.flg_sanctioned = 'Y'
          AND lp.flg_paid = 'N'
          AND NOT EXISTS (
              SELECT 1 FROM vouchers v
              WHERE v.remarks LIKE 'LOAN_CASE:' || lp.loancaseno || '%'
              AND v.status = 'PENDING'
          )
          AND NOT EXISTS (
              SELECT 1 FROM loan_master lm
              WHERE lm.loancaseno::text = lp.loancaseno::text
          )
          AND NOT EXISTS (
              SELECT 1 FROM loan_reagreements r
              WHERE r.new_loancaseno = lp.loancaseno AND r.status <> 'SANCTIONED'
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
                sanctioned: true,
                applicationKind: loan.application_kind || 'NEW',
                reagreementId: loan.reagreement_id ?? null,
            }));
        } catch (error) {
            console.error('[LoanSanction] Error getting sanctioned loan cases:', error);
            throw error; // an empty list would look like "nothing is sanctioned" (ES-402)
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
          REGEXP_REPLACE(TRIM(COALESCE(mm.f_name, '') || ' ' || COALESCE(mm.m_name, '') || ' ' || COALESCE(mm.l_name, '')), '\\s+', ' ', 'g') as member_name,
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
          REGEXP_REPLACE(TRIM(COALESCE(s1.f_name, '') || ' ' || COALESCE(s1.m_name, '') || ' ' || COALESCE(s1.l_name, '')), '\\s+', ' ', 'g') as s1_name,
          COALESCE(s1_d.name, 'Unknown Office') as s1_office,
          (COALESCE(s1_mb.regularloan, 0) + COALESCE(s1_mb.emergency_loan_balance, 0)) as s1_loan_balance,

          -- Surety 2 Details
          REGEXP_REPLACE(TRIM(COALESCE(s2.f_name, '') || ' ' || COALESCE(s2.m_name, '') || ' ' || COALESCE(s2.l_name, '')), '\\s+', ' ', 'g') as s2_name,
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
            console.log('[LoanSanction] Fetched Loan Details for Case:', caseNo);

            const reagreement = loan.application_kind === 'REAGREEMENT'
                ? await this.reagreementService.getByNewCase(String(loan.loancaseno), String(loan.mbno))
                : null;

            return {
                applicationKind: loan.application_kind || 'NEW',
                reagreement,
                rate: loan.rate !== null && loan.rate !== undefined ? loan.rate : undefined,
                penalRate: loan.penalrate !== null && loan.penalrate !== undefined ? loan.penalrate : undefined,
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
            console.error('[LoanSanction] Error getting loan details:', error);
            throw error;
        }
    }

    /**
     * Update loan with sanction details
     */
    async updateLoanSanction(caseNo: string, sanctionData: any, actor: string = 'system') {
        // A re-agreement is sanctioned like a normal loan, but its principal is locked to the outstanding
        // principal and the figures are recalculated by the re-agreement service.
        if (await this.reagreementService.isReagreementCase(this.dataSource, caseNo)) {
            return this.reagreementService.sanction(caseNo, {
                noOfInstallments: sanctionData.noOfInstallments, rate: sanctionData.rate,
                sanctionDate: sanctionData.sanctionDate, sanctionedAmount: sanctionData.sanctionedAmount,
            }, { actor });
        }
        // ES-318: validate before anything is written
        const sanctioned = Number(sanctionData.sanctionedAmount);
        if (sanctionData.sanctionedAmount === null || sanctionData.sanctionedAmount === '' || !Number.isFinite(sanctioned) || sanctioned <= 0 || sanctioned > 999_999_999.99) {
            throw new BadRequestException('Sanctioned amount must be a number greater than 0.');
        }
        const instRaw = sanctionData.noOfInstallments;
        const installments = Number(instRaw);
        if (instRaw === null || instRaw === undefined || instRaw === '' || !Number.isInteger(installments) || installments <= 0 || installments > 600) {
            throw new BadRequestException('Number of installments must be a whole number greater than 0.');
        }
        try {
            const pending = await this.dataSource.query(
                `SELECT lp.loancaseno, lp.mbno, lp.loantype, lp.applied_amt, lp.flg_paid,
                        EXISTS (SELECT 1 FROM loan_master lm WHERE lm.loancaseno::text = lp.loancaseno::text) AS disbursed
                 FROM loan_pending lp WHERE lp.loancaseno::numeric = $1::numeric`,
                [caseNo],
            );
            if (!pending || pending.length === 0) throw new Error('Loan case not found');
            if (pending[0].flg_paid === 'Y' || pending[0].disbursed === true) {
                throw new BadRequestException(`Loan case ${caseNo} is already paid out (loan created) and cannot be sanctioned again.`);
            }
            const applied = Number(pending[0].applied_amt);
            if (Number.isFinite(applied) && sanctioned > applied) {
                throw new BadRequestException(`Sanctioned amount ${sanctioned} is more than the applied amount ${applied}.`);
            }

            // ES-318: the limits of the loan type's own card in Business Rules (the same ones the application is checked against)
            const cardColumns: Record<string, { amt: string; inst: string }> = {
                RLN: { amt: 'rlnmaxloanamt', inst: 'rlnmaxnoinst' },
                ALN: { amt: 'alnmaxloanamt', inst: 'alnmaxnoinst' },
                ELN: { amt: 'elnmaxloanamt', inst: 'elnmaxnoinst' },
            };
            const card = cardColumns[String(pending[0].loantype ?? '').trim().toUpperCase()];
            if (card) {
                let cardMaxAmt = 0;
                let cardMaxInst = 0;
                try {
                    const cardRows = await this.dataSource.query(
                        `SELECT ${card.amt} AS max_amt, ${card.inst} AS max_inst FROM busrules ORDER BY appdate DESC LIMIT 1`,
                    );
                    cardMaxAmt = Number(cardRows?.[0]?.max_amt) || 0;
                    cardMaxInst = Number(cardRows?.[0]?.max_inst) || 0;
                } catch (e: any) {
                    console.warn(`[LoanSanction] Could not read the loan limits from Business Rules, limits not checked: ${e.message}`);
                }
                if (cardMaxAmt > 0 && sanctioned > cardMaxAmt) {
                    throw new BadRequestException(`Sanctioned amount ${sanctioned} is more than the maximum ${cardMaxAmt} set in Business Rules for this loan type.`);
                }
                if (cardMaxInst > 0 && installments > cardMaxInst) {
                    throw new BadRequestException(`${installments} installments is more than the maximum ${cardMaxInst} set in Business Rules for this loan type.`);
                }
            }

            // ES-506: per-customer rate exception (everything else comes from Business Rules at payout)
            const rateOverride = this.readRateOverride(sanctionData, await this.getRateDefaults(String(pending[0].loantype ?? '')));

            const updateQuery = `
        UPDATE loan_pending SET
          sanctioned_amt = $1,
          sanctioned_date = $2,
          no_of_instal = $3,
          flg_sanctioned = 'Y',
          rate = $5,
          penalrate = $6,
          rate_override_reason = $7,
          rate_override_by = $8
        WHERE loancaseno::numeric = $4::numeric
        RETURNING *
      `;

            const result = await this.dataSource.query(updateQuery, [
                sanctioned,
                parseSafeDate(sanctionData.sanctionDate),
                installments,
                caseNo,
                rateOverride.rate,
                rateOverride.penalRate,
                rateOverride.reason,
                rateOverride.reason ? String(actor || 'system').slice(0, 100) : null,
            ]);

            const sanctionedRows = Array.isArray(result[0]) ? result[0] : result; // [rows, count] shape
            if (sanctionedRows.length === 0) {
                throw new Error('Loan case not found');
            }

            console.log(`[LoanSanction] ✅ Loan ${caseNo} sanctioned successfully`);

            return {
                success: true,
                message: 'Loan sanctioned successfully',
                data: result[0]
            };
        } catch (error: any) {
            console.error('[LoanSanction] Error updating loan sanction:', error);
            if (error instanceof HttpException) throw error;
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
