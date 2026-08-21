import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, DataSource, QueryRunner } from 'typeorm';
import { DemandMaster } from '../entities/demand-master.entity';
import { generateVoucherNo } from '../../shared/utils/voucher-utils';

export interface LedgerSummaryDto {
    month: string;
    year: string;
    branch: string;
    fromMember?: string;
    toMember?: string;
}

export interface LedgerPostingDto {
    month: string;
    year: string;
    branch: string;
    modeOfReceipt: string;
    totalOfficeAmount: number;
}

const MONTH_MAP: Record<string, number> = {
    'JAN': 1, 'FEB': 2, 'MAR': 3, 'APR': 4, 'MAY': 5, 'JUN': 6,
    'JUL': 7, 'AUG': 8, 'SEP': 9, 'OCT': 10, 'NOV': 11, 'DEC': 12,
};

const HEAD_DEFS = [
    { code: 'RLN', name: 'Regular Loan Account', amtCol: 'rln_amount', intCol: null },
    { code: 'OTH', name: 'INTT FROM MEMBER', amtCol: null, intCol: 'rln_interest' },
    { code: 'ALN', name: 'EMERGENCY LOAN', amtCol: 'eln_amount', intCol: null },
    { code: 'CD', name: 'FIXED DEPOSIT', amtCol: 'rd_amount', intCol: null },
    { code: 'MD', name: 'FAMILY RELIEF SEHCEM', amtCol: null, intCol: null, fixedCol: 'frs1' },
    { code: 'MD1', name: 'FAMILY RELIEF SCHEME', amtCol: null, intCol: null, fixedCol: 'frs2' },
];

@Injectable()
export class LedgerPostingService {
    private readonly logger = new Logger(LedgerPostingService.name);

    constructor(
        @InjectRepository(DemandMaster)
        private readonly demandRepository: Repository<DemandMaster>,
        private readonly dataSource: DataSource,
    ) { }

    async getSummary(dto: LedgerSummaryDto) {
        const monthNum = MONTH_MAP[dto.month] || 0;
        const yearNum = parseInt(dto.year);
        if (!monthNum || !yearNum) return [];

        let query = `
            SELECT d.mbno, d.totaldemand, d.balance_for_month,
                   d.rln_installment_amount, d.eln_installment_amount, d.aln_installment_amount, d.rd_amount,
                   d.rln_interest, d.eln_interest, d.aln_interest,
                   d.md_amount, d.md1_amount,
                   d.demand_posted,
                   CONCAT(COALESCE(m.f_name,''), ' ', COALESCE(m.m_name,''), ' ', COALESCE(m.l_name,'')) as member_name
            FROM demand_master d
            LEFT JOIN member_master m ON d.mbno::text = m.mbno::text
            WHERE d.demand_for_month = $1 AND d.demand_for_year = $2
              AND (d.demand_posted IS NULL OR d.demand_posted = 'N')
        `;
        const params: any[] = [monthNum, yearNum];

        if (dto.branch) {
            query += ` AND d.officeno = $${params.length + 1}`;
            params.push(parseInt(dto.branch) || 0);
        }
        if (dto.fromMember) {
            query += ` AND d.mbno::bigint >= $${params.length + 1}`;
            params.push(parseInt(dto.fromMember));
        }
        if (dto.toMember) {
            query += ` AND d.mbno::bigint <= $${params.length + 1}`;
            params.push(parseInt(dto.toMember));
        }

        query += ` ORDER BY d.mbno`;

        const rows = await this.dataSource.query(query, params);

        // Build member-wise, head-wise breakdown
        const memberGroups: any[] = [];

        for (const row of rows) {
            const mbno = String(row.mbno);
            const heads: any[] = [];
            let totalSend = 0;

            const addHead = (code: string, name: string, amount: number) => {
                const amt = parseFloat(String(amount)) || 0;
                heads.push({
                    code,
                    headName: name,
                    balance: 0,
                    demandSend: amt,
                    demandReceived: amt,
                    shortRecovery: 0,
                });
                totalSend += amt;
            };

            addHead('RLN', 'Regular Loan Account', row.rln_installment_amount);
            addHead('OTH', 'INTT FROM MEMBER', row.rln_interest);
            addHead('ALN', 'EMERGENCY LOAN', row.eln_installment_amount);
            addHead('CD', 'FIXED DEPOSIT', row.rd_amount);
            addHead('MD', 'FAMILY RELIEF SEHCEM', row.md_amount);
            addHead('MD1', 'FAMILY RELIEF SCHEME', row.md1_amount);

            memberGroups.push({
                memberNo: mbno,
                memberName: (row.member_name || '').trim(),
                heads,
                totalSend,
                totalReceived: totalSend,
                totalShort: 0,
            });
        }

        return memberGroups;
    }

    async postUpdate(dto: LedgerPostingDto) {
        this.logger.log(`Posting demand ledger: ${JSON.stringify(dto)}`);

        const monthNum = MONTH_MAP[dto.month] || 0;
        const yearNum = parseInt(dto.year);

        if (!monthNum || !yearNum) {
            return { success: false, message: 'Invalid month/year parameters.' };
        }

        const queryRunner = this.dataSource.createQueryRunner();
        await queryRunner.connect();
        await queryRunner.startTransaction();

        try {
            // Fetch unposted demand records
            // BUG FIX 43: previously selected straight from demand_master with no check that
            // the member actually exists. A demand row for a member number not in member_master
            // would still get fully posted - real DR/CR ledger entries plus demand_posted='Y' -
            // for a member who doesn't exist, unreconcilable afterward. Now only rows with a
            // matching member are posted; the rest are left unposted (demand_posted stays 'N')
            // and reported back instead of silently pushing money into the void.
            let fetchQuery = `
                SELECT d.* FROM demand_master d
                INNER JOIN member_master m ON d.mbno::text = m.mbno::text
                WHERE d.demand_for_month = $1 AND d.demand_for_year = $2
                  AND (d.demand_posted IS NULL OR d.demand_posted = 'N')
            `;
            const fetchParams: any[] = [monthNum, yearNum];

            if (dto.branch) {
                fetchQuery += ` AND d.officeno = $3`;
                fetchParams.push(parseInt(dto.branch) || 0);
            }

            const demandRows = await queryRunner.query(fetchQuery, fetchParams);

            let missingQuery = `
                SELECT COUNT(*) as cnt FROM demand_master d
                LEFT JOIN member_master m ON d.mbno::text = m.mbno::text
                WHERE d.demand_for_month = $1 AND d.demand_for_year = $2
                  AND (d.demand_posted IS NULL OR d.demand_posted = 'N')
                  AND m.mbno IS NULL
            `;
            const missingParams: any[] = [monthNum, yearNum];
            if (dto.branch) {
                missingQuery += ` AND d.officeno = $3`;
                missingParams.push(parseInt(dto.branch) || 0);
            }
            const missingResult = await queryRunner.query(missingQuery, missingParams);
            const skippedNoMember = parseInt(missingResult[0]?.cnt || '0');

            if (demandRows.length === 0) {
                await queryRunner.rollbackTransaction();
                if (skippedNoMember > 0) {
                    return {
                        success: false,
                        message: `No postable demand records found for this period. ${skippedNoMember} record(s) skipped - member not found in the system.`,
                    };
                }
                return { success: false, message: 'No unposted demand records found for this period.' };
            }

            // Get next IDs
            // BUG FIX 35: ledger has no unique constraint on trans_no/ledgerid, so an unguarded
            // MAX()+1 lets concurrent postings silently write duplicate ids. Transaction-scoped
            // advisory lock serializes callers for the remainder of this transaction.
            await queryRunner.query(`SELECT pg_advisory_xact_lock(hashtext('ledger'))`);
            const idResult = await queryRunner.query(
                `SELECT COALESCE(MAX(trans_no), 0) + 1 as next_trans, COALESCE(MAX(ledgerid), 0) + 1 as next_ledger FROM ledger`
            );
            let nextTransNo = parseInt(idResult[0]?.next_trans || '1');
            let nextLedgerId = parseInt(idResult[0]?.next_ledger || '1');

            const transDate = new Date();
            const voucherNo = await generateVoucherNo(queryRunner, 'J');
            const modeOfPay = dto.modeOfReceipt === 'BANK' ? 'T' : 'C';
            const cashCode = modeOfPay === 'C' ? 'A1001' : 'A1008';

            let totalPosted = 0;

            for (const row of demandRows) {
                const mbno = row.mbno;
                const totalDemand = parseFloat(row.totaldemand) || 0;
                if (totalDemand <= 0) continue;

                // DR cash/bank for the total collected from this member
                await queryRunner.query(
                    `INSERT INTO ledger (trans_no, trans_date, trans_type, code, mbno, acc_no, acc_type, trans_amt, receipt_vchr_no, vchr_type, modeofpay, pl_balance, narration, username, ledgerid)
                     VALUES ($1, $2, 'DR', $3, $4, 0, 'CINH', $5, $6, 'JV', $7, 0, $8, 'SYSTEM', $9)`,
                    [nextTransNo++, transDate, cashCode, mbno, totalDemand, voucherNo, modeOfPay,
                     `Demand Recovery ${dto.month} ${dto.year}`, nextLedgerId++]
                );

                // CR individual heads
                const postHead = async (code: string, amount: number, narration: string) => {
                    if (amount <= 0) return;
                    // BUG FIX 42: CD/MD/MD1 pointed at wrong or nonexistent heads. A003 doesn't
                    // exist in headmaster at all; L1031/L1032 exist but are real, unrelated heads
                    // (LIC Insurance Premium, Staff Security Fund) - not FRS. Corrected to the
                    // heads whose head_name/headtype are exact matches: L1004 COMPULSORY DEPOSIT
                    // (headtype CD, same code already used correctly in
                    // compulsory-deposit.service.ts), L1002 FAMILY RELIEF SEHCEME(FRS 1)
                    // (headtype MD), L1045 FAMILY RELIEF SCHEME FUND(FRS 2) (headtype MD1).
                    const headCodeMap: Record<string, string> = {
                        'RLN': 'A1002', 'ALN': 'A1047', 'OTH': 'L1028',
                        'CD': 'L1004', 'MD': 'L1002', 'MD1': 'L1045',
                    };
                    const headCode = headCodeMap[code] || 'L1001';

                    await queryRunner.query(
                        `INSERT INTO ledger (trans_no, trans_date, trans_type, code, mbno, acc_no, acc_type, trans_amt, receipt_vchr_no, vchr_type, modeofpay, pl_balance, narration, username, ledgerid)
                         VALUES ($1, $2, 'CR', $3, $4, 0, 'JV', $5, $6, 'JV', $7, 0, $8, 'SYSTEM', $9)`,
                        [nextTransNo++, transDate, headCode, mbno, amount, voucherNo, modeOfPay, narration, nextLedgerId++]
                    );
                };

                await postHead('RLN', parseFloat(row.rln_installment_amount) || 0, 'Regular Loan Recovery');
                await postHead('OTH', parseFloat(row.rln_interest) || 0, 'Loan Interest Recovery');
                await postHead('ALN', parseFloat(row.eln_installment_amount) || 0, 'Emergency Loan Recovery');
                await postHead('CD', parseFloat(row.rd_amount) || 0, 'FD/RD Recovery');
                // BUG FIX 42: MD/MD1 (FRS 1/2) were defined in HEAD_DEFS/headCodeMap but never
                // actually posted here. The DR leg above still includes totalDemand (which
                // includes the FRS portion), so every recovery run with FRS money produced an
                // out-of-balance ledger and the relief fund itself never recorded receiving it.
                await postHead('MD', parseFloat(row.md_amount) || 0, 'FRS-1 Recovery');
                await postHead('MD1', parseFloat(row.md1_amount) || 0, 'FRS-2 Recovery');

                // Update member_balances for loan repayments
                const rlnAmt = parseFloat(row.rln_installment_amount) || 0;
                const elnAmt = parseFloat(row.eln_installment_amount) || 0;
                const rlnInterestAmt = parseFloat(row.rln_interest) || 0;
                const elnInterestAmt = parseFloat(row.eln_interest) || 0;
                if (rlnAmt > 0) {
                    await queryRunner.query(
                        `UPDATE member_balances SET regularloan = GREATEST(0, COALESCE(regularloan, 0) - $1) WHERE mbno = $2`,
                        [rlnAmt, mbno]
                    );
                }
                if (elnAmt > 0) {
                    await queryRunner.query(
                        `UPDATE member_balances SET emergency_loan_balance = GREATEST(0, COALESCE(emergency_loan_balance, 0) - $1) WHERE mbno = $2`,
                        [elnAmt, mbno]
                    );
                }

                // Bring this bulk posting into the same ledger the individual Loan
                // Repayment screen writes to: reduce the actual loan_master.balance
                // (principal only, oldest loan case of that type first) and record a
                // loan_repayment_ledger row, so getDueStatus/penal/EMI-schedule logic
                // can see that this member's demand was in fact recovered here instead
                // of treating it as unpaid since disbursement.
                if (rlnAmt > 0 || rlnInterestAmt > 0) {
                    await this.applyRecoveryToLoanCases(
                        queryRunner, mbno, ['RLN'], rlnAmt, rlnInterestAmt, monthNum, yearNum, voucherNo
                    );
                }
                if (elnAmt > 0 || elnInterestAmt > 0) {
                    await this.applyRecoveryToLoanCases(
                        queryRunner, mbno, ['ALN', 'ELN'], elnAmt, elnInterestAmt, monthNum, yearNum, voucherNo
                    );
                }

                totalPosted += totalDemand;

                // Mark as posted
                await queryRunner.query(
                    `UPDATE demand_master SET demand_posted = 'Y', dmnd_post_date = NOW(), receipt_vchr_no = $1
                     WHERE demand_for_month = $2 AND demand_for_year = $3 AND mbno = $4`,
                    [voucherNo, monthNum, yearNum, mbno]
                );
            }

            // Insert cashbook summary
            await queryRunner.query(
                `INSERT INTO tblcashbook (headcode, headname, rcash, rtransfer, pcash, ptransfer, trans_date)
                 VALUES ($1, $2, $3, $4, 0, 0, $5)`,
                [cashCode, `Demand Recovery ${dto.month} ${dto.year}`,
                 modeOfPay === 'C' ? totalPosted : 0,
                 modeOfPay === 'T' ? totalPosted : 0,
                 transDate]
            );

            await queryRunner.commitTransaction();

            return {
                success: true,
                message: `Posted ${demandRows.length} member demands. Total: ₹${totalPosted.toLocaleString('en-IN')}` +
                    (skippedNoMember > 0 ? `. ${skippedNoMember} record(s) skipped - member not found in the system.` : ''),
                recordCount: demandRows.length,
                totalPosted,
                voucherNo,
                skippedNoMember,
            };
        } catch (error: any) {
            await queryRunner.rollbackTransaction();
            this.logger.error('Ledger posting failed', error);
            throw new Error('Failed to post ledger: ' + error.message);
        } finally {
            await queryRunner.release();
        }
    }

    /**
     * Allocate a recovered principal/interest amount for one loan type across
     * a member's active loan_master rows, oldest-disbursed first — the same
     * recovery-order rule the individual Loan Repayment screen enforces — and
     * record it in loan_repayment_ledger so due-status/EMI-schedule/penal
     * calculations can see it. demand_master tracks recovery per member, not
     * per loan case, so when a member holds more than one active loan of the
     * same type the principal cascades through them oldest-first; interest is
     * attributed in the same proportion as the principal it rode in with.
     */
    private async applyRecoveryToLoanCases(
        queryRunner: QueryRunner,
        mbno: string | number,
        loanTypes: string[],
        principalAmount: number,
        interestAmount: number,
        paymentMonth: number,
        paymentYear: number,
        voucherNo: string,
    ): Promise<void> {
        if (principalAmount <= 0 && interestAmount <= 0) return;

        const loans = await queryRunner.query(
            `SELECT loancaseno, loantype, CAST(balance AS numeric) as balance FROM loan_master
             WHERE mbno = $1 AND loantype = ANY($2) AND CAST(balance AS numeric) > 0
             ORDER BY payment_date ASC`,
            [mbno, loanTypes]
        );

        if (loans.length === 0) return; // nothing active to apply against — funds are still recorded via member_balances/ledger above

        let remainingPrincipal = principalAmount;
        const allocations: { loancaseno: string; loantype: string; principal: number }[] = [];

        for (const loan of loans) {
            if (remainingPrincipal <= 0) break;
            const balance = parseFloat(loan.balance) || 0;
            const applied = Math.round(Math.min(remainingPrincipal, balance) * 100) / 100;
            if (applied <= 0) continue;
            allocations.push({ loancaseno: String(loan.loancaseno), loantype: loan.loantype, principal: applied });
            remainingPrincipal -= applied;
        }

        // No active loan had principal outstanding to apply against, but there's
        // still interest to record — attribute it to the oldest active case.
        if (allocations.length === 0 && interestAmount > 0) {
            allocations.push({ loancaseno: String(loans[0].loancaseno), loantype: loans[0].loantype, principal: 0 });
        }

        const totalAllocatedPrincipal = allocations.reduce((sum, a) => sum + a.principal, 0);

        for (const alloc of allocations) {
            const share = totalAllocatedPrincipal > 0 ? alloc.principal / totalAllocatedPrincipal : (1 / allocations.length);
            const interestShare = Math.round(interestAmount * share * 100) / 100;

            if (alloc.principal > 0) {
                await queryRunner.query(
                    `UPDATE loan_master SET balance = GREATEST(0, CAST(balance AS numeric) - $1) WHERE loancaseno::text = $2`,
                    [alloc.principal, alloc.loancaseno]
                );
            }

            await queryRunner.query(
                `INSERT INTO loan_repayment_ledger
                    (mbno, loancaseno, loantype, payment_date, payment_month, payment_year, payment_amount,
                     principal_amount, interest_amount, penal_amount, months_overdue,
                     receipt_no, narration, posted_by)
                 VALUES ($1, $2, $3, CURRENT_DATE, $4, $5, $6, $7, $8, 0, 0, $9, $10, 'SYSTEM-BULK')`,
                [
                    mbno, alloc.loancaseno, alloc.loantype,
                    paymentMonth, paymentYear,
                    Math.round((alloc.principal + interestShare) * 100) / 100,
                    alloc.principal, interestShare,
                    voucherNo,
                    'Bulk Demand Recovery Posting',
                ]
            );
        }
        // Any leftover principal beyond every active loan's balance (e.g. demand
        // slightly overstated vs loan_master) is left unapplied — loan_master.balance
        // never goes negative, and this is a rare rounding/data-drift tail.
    }
}
