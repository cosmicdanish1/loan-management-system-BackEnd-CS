import { Injectable, Logger } from '@nestjs/common';
import { assertPostingDateOpen } from '../../shared/utils/posting-date';
import { lockLedgerIds } from '../../shared/utils/ledger-lock';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, DataSource } from 'typeorm';
import { DemandMaster } from '../entities/demand-master.entity';

export interface LedgerSummaryDto {
    month: string;
    year: string;
    branch: string;
}

export interface LedgerPostingDto {
    month: string;
    year: string;
    head: string;
    totalAmount: number;
    recordCount: number;
    branch?: string;
    totalOfficeAmount?: number;
    modeOfReceipt?: string;
}

@Injectable()
export class LedgerPostingService {
    private readonly logger = new Logger(LedgerPostingService.name);

    constructor(
        @InjectRepository(DemandMaster)
        private readonly demandRepository: Repository<DemandMaster>,
        private readonly dataSource: DataSource,
    ) { }

    /** db: the posting's own transaction when called from postUpdate, so the summary is read under its lock */
    async getSummary(dto: LedgerSummaryDto, db: { query: (sql: string, params?: any[]) => Promise<any> } = this.dataSource) {
        const monthMap: { [key: string]: number } = {
            'JAN': 1, 'FEB': 2, 'MAR': 3, 'APR': 4, 'MAY': 5, 'JUN': 6,
            'JUL': 7, 'AUG': 8, 'SEP': 9, 'OCT': 10, 'NOV': 11, 'DEC': 12
        };
        const monthNum = monthMap[dto.month] || 0;
        const yearNum = parseInt(dto.year);

        if (!monthNum || !yearNum) return [];

        const params: any[] = [monthNum, yearNum];
        const conditions = ['dm.demand_for_month = $1', 'dm.demand_for_year = $2', "COALESCE(dm.demand_posted,'N') <> 'Y'"];
        if (dto.branch) {
            params.push(dto.branch);
            conditions.push(`dm.officeno::text = $${params.length}`);
        }
        const rows = await db.query(
            `SELECT dm.mbno, dm.totaldemand, dm.balance_for_month,
                    COALESCE(dm.rln_installment_amount,0)+COALESCE(dm.eln_installment_amount,0)+COALESCE(dm.aln_installment_amount,0)+COALESCE(dm.mln_installment_amount,0) principal,
                    COALESCE(dm.rln_interest,0)+COALESCE(dm.eln_interest,0)+COALESCE(dm.aln_interest,0)+COALESCE(dm.mln_interest,0) interest,
                    COALESCE(dm.rd_amount,0)+COALESCE(dm.md_amount,0)+COALESCE(dm.cd_amount,0)+COALESCE(dm.shr_amount,0) savings,
                    REGEXP_REPLACE(TRIM(COALESCE(mm.f_name,'') || ' ' || COALESCE(mm.m_name,'') || ' ' || COALESCE(mm.l_name,'')), '\\s+', ' ', 'g') member_name
             FROM demand_master dm LEFT JOIN member_master mm ON mm.mbno = dm.mbno
             WHERE ${conditions.join(' AND ')} ORDER BY dm.mbno`,
            params,
        );
        return rows.map((r: any) => {
            const total = Number(r.totaldemand) || 0;
            const balance = Math.max(0, Number(r.balance_for_month) || 0);
            let principal = Number(r.principal) || 0;
            let interest = Number(r.interest) || 0;
            let savings = Number(r.savings) || 0;
            if (principal + interest + savings === 0 && total > 0) principal = total;
            const heads = [
                ['PRINCIPAL', 'Loan Principal', principal],
                ['INTEREST', 'Loan Interest', interest],
                ['SAVINGS', 'Savings Contribution', savings],
            ].filter(([, , amount]) => Number(amount) > 0).map(([code, headName, amount]) => {
                const send = Number(amount);
                const shortRecovery = total > 0 ? Math.min(send, balance * send / total) : 0;
                return { code, headName, balance: shortRecovery, demandSend: send, demandReceived: send - shortRecovery, shortRecovery };
            });
            return {
                memberNo: String(r.mbno),
                memberName: r.member_name || `Member ${r.mbno}`,
                heads,
                totalSend: heads.reduce((s: number, h: any) => s + h.demandSend, 0),
                totalReceived: heads.reduce((s: number, h: any) => s + h.demandReceived, 0),
                totalShort: heads.reduce((s: number, h: any) => s + h.shortRecovery, 0),
            };
        });
    }

    async postUpdate(dto: LedgerPostingDto) {
        this.logger.log(`Posting ledger update: ${JSON.stringify(dto)}`);

        const monthMap: { [key: string]: number } = {
            'JAN': 1, 'FEB': 2, 'MAR': 3, 'APR': 4, 'MAY': 5, 'JUN': 6,
            'JUL': 7, 'AUG': 8, 'SEP': 9, 'OCT': 10, 'NOV': 11, 'DEC': 12
        };
        const monthNum = monthMap[dto.month] || 0;
        const yearNum = parseInt(dto.year);

        const requestedAmount = Number(dto.totalOfficeAmount ?? dto.totalAmount);
        if (!monthNum || !yearNum || !Number.isFinite(requestedAmount) || requestedAmount <= 0) {
            return { success: false, message: 'Invalid parameters for ledger posting.' };
        }

        const queryRunner = this.dataSource.createQueryRunner();
        await queryRunner.connect();
        await queryRunner.startTransaction();

        try {
            // ES-414: lock this month's posting BEFORE reading what is still unposted, on this transaction. A second
            // request for the same month waits here, then finds the demands already marked posted and is refused by
            // the amount check, so the month can never be posted twice. The id lock below keeps trans_no/ledgerid unique.
            await queryRunner.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`demand_posting:${monthNum}:${yearNum}`]);
            await queryRunner.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, ['ledger.trans_no']);
            await assertPostingDateOpen(queryRunner, new Date()); // ES-458
            const groups = await this.getSummary({ month: dto.month, year: dto.year, branch: dto.branch || '' }, queryRunner);
            const expectedAmount = groups.reduce((sum: number, g: any) => sum + Number(g.totalSend || 0), 0);
            if (Math.abs(expectedAmount - requestedAmount) > 0.01) {
                throw new Error(`Posting total ₹${requestedAmount.toFixed(2)} does not match pending demand ₹${expectedAmount.toFixed(2)}`);
            }
            await lockLedgerIds(queryRunner); // ES-445
            const transResult = await queryRunner.query(
                `SELECT COALESCE(MAX(trans_no), 0) + 1 as next_no, COALESCE(MAX(ledgerid), 0) + 1 as next_ledger_id FROM ledger`
            );
            let transNo = parseInt(transResult[0]?.next_no || '1');
            let ledgerId = parseInt(transResult[0]?.next_ledger_id || '1');

            const transDate = new Date();
            const voucherNo = `G${String(transNo).padStart(5, '0').slice(-5)}`;

            // ES-414: post every head of the demand with its own amount. Before, the whole demand total was posted
            // under the one head named in the request while ALL demands were then marked posted, so the other heads
            // never reached the ledger. Credit heads are the ones this service already used; the right GL head for
            // each part is still a business decision (see Jira).
            const headPlan: Array<{ key: string; label: string; crCode: string; accType: string }> = [
                { key: 'PRINCIPAL', label: 'Loan Principal', crCode: 'A1003', accType: 'LN' },
                { key: 'INTEREST', label: 'Loan Interest', crCode: 'L1028', accType: 'LN' },
                { key: 'SAVINGS', label: 'Savings Contribution', crCode: 'L1001', accType: 'SB' },
            ];
            const drCode = 'A1001';
            const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;
            const postedHeads: Array<{ head: string; amount: number }> = [];
            for (const plan of headPlan) {
                const amount = round2(groups.reduce((sum: number, g: any) =>
                    sum + (g.heads || []).filter((h: any) => h.code === plan.key).reduce((t: number, h: any) => t + Number(h.demandSend || 0), 0), 0));
                if (amount <= 0) continue;
                const narration = `GL Posting - ${plan.label} for ${dto.month} ${dto.year}`;

                // BUG FIX: both ledger INSERTs were missing the 'ledgerid' column — every other ledger
                // INSERT in the codebase includes it. Without it this throws a NOT NULL constraint error.
                await queryRunner.query(
                    `INSERT INTO ledger (trans_no, trans_date, trans_type, code, mbno, acc_no, acc_type, trans_amt, receipt_vchr_no, vchr_type, modeofpay, pl_balance, narration, username, ledgerid)
                     VALUES ($1, $2, 'DR', $3, 0, 0, $4, $5, $6, 'GL', 'C', 0, $7, 'SYSTEM', $8)`,
                    [transNo++, transDate, drCode, plan.accType, amount, voucherNo, narration, ledgerId++]
                );
                await queryRunner.query(
                    `INSERT INTO ledger (trans_no, trans_date, trans_type, code, mbno, acc_no, acc_type, trans_amt, receipt_vchr_no, vchr_type, modeofpay, pl_balance, narration, username, ledgerid)
                     VALUES ($1, $2, 'CR', $3, 0, 0, $4, $5, $6, 'GL', 'C', 0, $7, 'SYSTEM', $8)`,
                    [transNo++, transDate, plan.crCode, plan.accType, amount, voucherNo, narration, ledgerId++]
                );
                postedHeads.push({ head: plan.label, amount });
            }

            // ES-447: the recovered loan principal/interest must also reach the loans themselves, in the same transaction.
            // Posting only the GL rows left loan_master.balance, member_balances and loan_repayment_ledger untouched, so a
            // loan paid through payroll looked unpaid. (This is the "bulk door" of the repayment design; it was dropped by
            // commit 2cfd3e7 and is restored here.) Must run BEFORE the demand rows are marked posted.
            const recovery = await this.applyDemandRecoveryToLoans(queryRunner, monthNum, yearNum, dto.branch, voucherNo);

            await queryRunner.query(
                `UPDATE demand_master SET demand_posted = 'Y', passflag = 'Y', dmnd_post_date = NOW()
                 WHERE demand_for_month = $1 AND demand_for_year = $2
                   AND COALESCE(demand_posted,'N') <> 'Y'
                   ${dto.branch ? 'AND officeno::text = $3' : ''}`,
                dto.branch ? [monthNum, yearNum, dto.branch] : [monthNum, yearNum],
            );

            await queryRunner.commitTransaction();

            return {
                success: true,
                voucherNo,
                recordCount: groups.length,
                totalPosted: requestedAmount,
                heads: postedHeads,
                loanRecovery: recovery,
                message: `Successfully posted ₹${requestedAmount} to General Ledger for ${dto.month} ${dto.year}.`
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
     * ES-447: apply one month's recovered loan money to the members' loans. Runs inside postUpdate's transaction.
     *
     * demand_master tracks recovery per member and loan type, not per loan case. For each member and loan type the
     * principal is applied across the member's active loans of that type, oldest-disbursed first (the same recovery
     * order the Loan Repayment screen uses). Each case gets one loan_repayment_ledger row, tagged payment_source
     * 'DEMAND' for the demand month (demand money pays its own month) and posted_by 'SYSTEM-BULK'; loan_master.balance
     * and member_balances move by the principal actually applied; interest rides with the principal in proportion.
     * A loan row is locked FOR UPDATE, so a manual repayment on the same loan waits instead of racing. Principal left
     * over after every active loan is repaid is not applied (a balance never goes negative).
     */
    private async applyDemandRecoveryToLoans(
        queryRunner: { query: (sql: string, params?: any[]) => Promise<any> },
        monthNum: number,
        yearNum: number,
        branch: string | undefined,
        voucherNo: string,
    ): Promise<{ members: number; loanCases: number; principal: number; interest: number }> {
        const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;
        const rows = await queryRunner.query(
            `SELECT mbno,
                    COALESCE(rln_installment_amount,0) AS rln_p, COALESCE(rln_interest,0) AS rln_i,
                    COALESCE(eln_installment_amount,0) AS eln_p, COALESCE(eln_interest,0) AS eln_i,
                    COALESCE(aln_installment_amount,0) AS aln_p, COALESCE(aln_interest,0) AS aln_i,
                    COALESCE(mln_installment_amount,0) AS mln_p, COALESCE(mln_interest,0) AS mln_i
               FROM demand_master
              WHERE demand_for_month = $1 AND demand_for_year = $2
                AND COALESCE(demand_posted,'N') <> 'Y'
                ${branch ? 'AND officeno::text = $3' : ''}
              ORDER BY mbno
              FOR UPDATE`,
            branch ? [monthNum, yearNum, branch] : [monthNum, yearNum],
        );

        const loanTypes: Array<{ key: 'rln' | 'eln' | 'aln' | 'mln'; type: string }> = [
            { key: 'rln', type: 'RLN' }, { key: 'eln', type: 'ELN' }, { key: 'aln', type: 'ALN' }, { key: 'mln', type: 'MLN' },
        ];
        // loan types whose outstanding balance lives in member_balances.emergency_loan_balance (same rule as Loan Repayment)
        const emergencyTypes = ['ELN', 'ALN', 'A', 'E', 'EMR', 'ADD'];

        const summary = { members: 0, loanCases: 0, principal: 0, interest: 0 };
        for (const row of rows) {
            let touched = false;
            for (const { key, type } of loanTypes) {
                const principalDemand = round2(Number(row[`${key}_p`]) || 0);
                const interestDemand = round2(Number(row[`${key}_i`]) || 0);
                if (principalDemand <= 0 && interestDemand <= 0) continue;

                const loans = await queryRunner.query(
                    `SELECT loancaseno, loantype, CAST(balance AS numeric) AS balance FROM loan_master
                      WHERE mbno::text = $1::text AND UPPER(loantype) = $2 AND CAST(balance AS numeric) > 0
                      ORDER BY payment_date ASC, loancaseno ASC
                      FOR UPDATE`,
                    [String(row.mbno), type],
                );
                if (loans.length === 0) continue; // no active loan of this type: nothing to apply against

                let remaining = principalDemand;
                const allocations: Array<{ loancaseno: string; loantype: string; principal: number }> = [];
                for (const loan of loans) {
                    if (remaining <= 0) break;
                    const applied = round2(Math.min(remaining, Number(loan.balance) || 0));
                    if (applied <= 0) continue;
                    allocations.push({ loancaseno: String(loan.loancaseno), loantype: loan.loantype, principal: applied });
                    remaining = round2(remaining - applied);
                }
                // only interest was recovered (or every loan is already repaid): attach it to the oldest active case
                if (allocations.length === 0 && interestDemand > 0) {
                    allocations.push({ loancaseno: String(loans[0].loancaseno), loantype: loans[0].loantype, principal: 0 });
                }

                const allocatedPrincipal = round2(allocations.reduce((s, a) => s + a.principal, 0));
                let interestLeft = interestDemand;
                for (let i = 0; i < allocations.length; i++) {
                    const a = allocations[i];
                    // interest follows the principal it came with; the last case takes the rounding remainder
                    const share = allocatedPrincipal > 0 ? a.principal / allocatedPrincipal : 1 / allocations.length;
                    const interestShare = i === allocations.length - 1 ? round2(interestLeft) : round2(interestDemand * share);
                    interestLeft = round2(interestLeft - interestShare);

                    if (a.principal > 0) {
                        await queryRunner.query(
                            `UPDATE loan_master SET balance = GREATEST(0, CAST(balance AS numeric) - $1)
                              WHERE loancaseno::text = $2 AND mbno::text = $3::text AND loantype = $4`,
                            [a.principal, a.loancaseno, String(row.mbno), a.loantype],
                        );
                        const balanceColumn = emergencyTypes.includes(String(a.loantype).toUpperCase()) ? 'emergency_loan_balance' : 'regularloan';
                        await queryRunner.query(
                            `UPDATE member_balances SET ${balanceColumn} = GREATEST(0, COALESCE(${balanceColumn}, 0) - $1) WHERE mbno::numeric = $2::numeric`,
                            [a.principal, String(row.mbno)],
                        );
                    }
                    await queryRunner.query(
                        `INSERT INTO loan_repayment_ledger
                            (mbno, loancaseno, loantype, payment_date, payment_month, payment_year, payment_amount,
                             principal_amount, interest_amount, penal_amount, months_overdue,
                             receipt_no, narration, posted_by, payment_source)
                         VALUES ($1, $2, $3, CURRENT_DATE, $4, $5, $6, $7, $8, 0, 0, $9, $10, 'SYSTEM-BULK', 'DEMAND')`,
                        [
                            row.mbno, a.loancaseno, a.loantype, monthNum, yearNum,
                            round2(a.principal + interestShare), a.principal, interestShare,
                            voucherNo, 'Bulk Demand Recovery Posting',
                        ],
                    );
                    summary.loanCases++;
                    summary.principal = round2(summary.principal + a.principal);
                    summary.interest = round2(summary.interest + interestShare);
                    touched = true;
                }
            }
            if (touched) summary.members++;
        }
        return summary;
    }
}
