import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { generateVoucherNo } from '../../shared/utils/voucher-utils';
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
export class LedgerPostingService implements OnModuleInit {
    private readonly logger = new Logger(LedgerPostingService.name);

    /** ES-503: the G counter column (idempotent; same statement as database/migrations/add-g-voucher-counter.sql). */
    async onModuleInit(): Promise<void> {
        await this.dataSource.query(`ALTER TABLE voucher_master ADD COLUMN IF NOT EXISTS g_vchr_no varchar(20) NOT NULL DEFAULT 'G00000'`);
    }

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
                    COALESCE(dm.rd_amount,0)+COALESCE(dm.md_amount,0)+COALESCE(dm.md1_amount,0)+COALESCE(dm.cd_amount,0)+COALESCE(dm.shr_amount,0) savings,
                    REGEXP_REPLACE(TRIM(COALESCE(mm.f_name,'') || ' ' || COALESCE(mm.m_name,'') || ' ' || COALESCE(mm.l_name,'')), '\\s+', ' ', 'g') member_name
             FROM demand_master dm LEFT JOIN member_master mm ON mm.mbno = dm.mbno
             WHERE ${conditions.join(' AND ')} ORDER BY dm.mbno`,
            params,
        );
        return rows.map((r: any) => {
            const total = Number(r.totaldemand) || 0;
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
                // ES-624: demand_master.balance_for_month is the UNPAID amount of the month. The importer and the generator
                // set it to the total and this posting clears it, so while a month is waiting to be posted it is always
                // the whole demand. It is not a short recovery: the amounts being posted are what the payroll recovered,
                // so Demand Received = Demand Send and nothing is short (this used to read the unpaid amount as the
                // shortfall, showed Received 0 for a freshly imported month and the window refused to post it).
                return { code, headName, balance: 0, demandSend: send, demandReceived: send, shortRecovery: 0 };
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
            // ES-503: the number came from the last 5 digits of trans_no and repeated every 100,000 ledger numbers. It now
            // comes from its own counter (voucher_master.g_vchr_no, G00001, G00002 ...) that never wraps and skips any G
            // number already used. Old G vouchers are not renumbered.
            const voucherNo = await generateVoucherNo(queryRunner, 'G');

            // ES-414: post every head of the demand with its own amount. Before, the whole demand total was posted
            // under the one head named in the request while ALL demands were then marked posted, so the other heads
            // never reached the ledger. Credit heads are the ones this service already used; the right GL head for
            // each part is still a business decision (see Jira).
            const headPlan: Array<{ key: string; label: string; crCode: string; accType: string }> = [
                { key: 'PRINCIPAL', label: 'Loan Principal', crCode: 'A1003', accType: 'LN' },
                { key: 'INTEREST', label: 'Loan Interest', crCode: 'L1028', accType: 'LN' },
                // SAVINGS (RD, MD, CD, share) is NOT posted as one lump here any more: like the legacy payroll voucher it is
                // credited to each MEMBER's own deposit head and balance, see postMemberDeposits below.
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

            // The deposit parts of the payroll (RD/CD, MD, share) are credited to each member's own head and balance, one
            // line per member and head, exactly as the legacy payroll voucher did (CR L1004 / L1002 / L1001 with the member
            // number). Before, they were one lump on L1001 with member 0, so no member's CD/RD ever grew.
            const deposits = await this.postMemberDeposits(queryRunner, monthNum, yearNum, dto.branch, voucherNo, transDate, transNo, ledgerId, drCode);
            transNo = deposits.transNo; ledgerId = deposits.ledgerId;
            postedHeads.push(...deposits.postedHeads);

            // ES-447: the recovered loan principal/interest must also reach the loans themselves, in the same transaction.
            // Posting only the GL rows left loan_master.balance, member_balances and loan_repayment_ledger untouched, so a
            // loan paid through payroll looked unpaid. (This is the "bulk door" of the repayment design; it was dropped by
            // commit 2cfd3e7 and is restored here.) Must run BEFORE the demand rows are marked posted.
            const recovery = await this.applyDemandRecoveryToLoans(queryRunner, monthNum, yearNum, dto.branch, voucherNo);

            await queryRunner.query(
                // ES-624: the month's demand has been recovered and posted, so nothing of it is unpaid any more
                `UPDATE demand_master SET demand_posted = 'Y', passflag = 'Y', dmnd_post_date = NOW(), balance_for_month = 0
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
                message: `Successfully posted ₹${requestedAmount} to General Ledger for ${dto.month} ${dto.year}.` +
                    // ES-590: never silent: money the ledger took but no loan could take (no active loan, or more than the balance)
                    (recovery.unappliedPrincipal > 0 || recovery.unappliedInterest > 0
                        ? ` Not applied to any loan: principal ₹${recovery.unappliedPrincipal.toFixed(2)}, interest ₹${recovery.unappliedInterest.toFixed(2)} (the member has no active loan for it).`
                        : ''),
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
     * Credits one month's deposit demand to each member, like the legacy payroll voucher: per member and head one ledger CR
     * line with the member number (RD+CD -> L1004, MD -> L1002, MD1 -> L1045, share -> L1001), and the member's stored balance
     * (member_balances.compulsory_deposit / frsbalance (MD + MD1) / shares) goes up by the same amount, in the same transaction.
     * The matching DR (cash received) is one line per head with member 0, the shape this service already used.
     * RD and CD are one deposit, so rd_amount is added to cd_amount.
     */
    private async postMemberDeposits(
        queryRunner: { query: (sql: string, params?: any[]) => Promise<any> },
        monthNum: number, yearNum: number, branch: string | undefined, voucherNo: string, transDate: Date,
        transNo: number, ledgerId: number, drCode: string,
    ): Promise<{ transNo: number; ledgerId: number; postedHeads: Array<{ head: string; amount: number }> }> {
        const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;
        const rows = await queryRunner.query(
            `SELECT mbno,
                    COALESCE(cd_amount,0) + COALESCE(rd_amount,0) AS cd,
                    COALESCE(md_amount,0) AS md,
                    COALESCE(md1_amount,0) AS md1,
                    COALESCE(shr_amount,0) AS shr
               FROM demand_master
              WHERE demand_for_month = $1 AND demand_for_year = $2
                AND COALESCE(demand_posted,'N') <> 'Y'
                ${branch ? 'AND officeno::text = $3' : ''}
              ORDER BY mbno
              FOR UPDATE`,
            branch ? [monthNum, yearNum, branch] : [monthNum, yearNum],
        );
        const parts: Array<{ key: 'cd' | 'md' | 'md1' | 'shr'; label: string; code: string; accType: string; balanceColumn: string }> = [
            { key: 'cd', label: 'Compulsory Deposit (RD)', code: 'L1004', accType: 'CD', balanceColumn: 'compulsory_deposit' },
            // ES-589: FRS1 = MD (L1002) and FRS2 = MD1 (L1045). Both are credited to the member's own head, and the member's
            // single stored FRS balance (frsbalance) is FRS1 + FRS2, as the Member Complete Detail screen defines it.
            { key: 'md', label: 'Monthly Deposit (FRS 1)', code: 'L1002', accType: 'MD', balanceColumn: 'frsbalance' },
            { key: 'md1', label: 'Monthly Deposit 2 (FRS 2)', code: 'L1045', accType: 'MD1', balanceColumn: 'frsbalance' },
            { key: 'shr', label: 'Share', code: 'L1001', accType: 'SHR', balanceColumn: 'shares' },
        ];
        const insertLedger = async (type: 'DR' | 'CR', code: string, mbno: any, accType: string, amount: number, narration: string) => {
            await queryRunner.query(
                `INSERT INTO ledger (trans_no, trans_date, trans_type, code, mbno, acc_no, acc_type, trans_amt, receipt_vchr_no, vchr_type, modeofpay, pl_balance, narration, username, ledgerid)
                 VALUES ($1, $2, $3, $4, $5, 0, $6, $7, $8, 'GL', 'C', 0, $9, 'SYSTEM', $10)`,
                [transNo++, transDate, type, code, mbno, accType, amount, voucherNo, narration, ledgerId++],
            );
        };
        const postedHeads: Array<{ head: string; amount: number }> = [];
        for (const part of parts) {
            let total = 0;
            const narration = `GL Posting - ${part.label} for ${String(monthNum).padStart(2, '0')}/${yearNum}`;
            for (const row of rows) {
                const amount = round2(Number(row[part.key]) || 0);
                if (amount <= 0) continue;
                await insertLedger('CR', part.code, row.mbno, part.accType, amount, narration);
                const updated = await queryRunner.query(
                    `UPDATE member_balances SET ${part.balanceColumn} = COALESCE(${part.balanceColumn}, 0) + $1 WHERE mbno::numeric = $2::numeric`,
                    [amount, String(row.mbno)],
                );
                // a member with no balance row yet gets one, the same minimal shape the rest of the app inserts
                if (!updated[1]) {
                    await queryRunner.query(`INSERT INTO member_balances (mbno, ${part.balanceColumn}) VALUES ($1, $2)`, [row.mbno, amount]);
                }
                total = round2(total + amount);
            }
            if (total > 0) {
                await insertLedger('DR', drCode, 0, part.accType, total, narration);
                postedHeads.push({ head: part.label, amount: total });
            }
        }
        return { transNo, ledgerId, postedHeads };
    }

    /**
     * ES-447: apply one month's recovered loan money to the members' loans. Runs inside postUpdate's transaction.
     *
     * demand_master tracks recovery per member and loan type, not per loan case. For each member and loan type the
     * principal is applied across the member's active loans of that type, oldest-disbursed first (the same recovery
     * order the Loan Repayment screen uses). Each case gets ONE loan_repayment_ledger row for the run, tagged
     * payment_source 'DEMAND' for the demand month (demand money pays its own month) and posted_by 'SYSTEM-BULK';
     * loan_master.balance and member_balances move by the principal actually applied; interest rides with the principal
     * in proportion. A loan row is locked FOR UPDATE, so a manual repayment on the same loan waits instead of racing.
     *
     * ES-590: whatever is posted from the demand must reach a loan. The payroll file has ONE interest column and the
     * demand rows keep all of it under the regular loan, so a member with only an emergency loan has interest "of a
     * type without an active loan". That interest goes to the member's other loan: the first loan that received
     * principal in this run, else the member's oldest active loan of any type.
     *
     * Money no loan can take (principal of a type with no active loan, principal above the balance, interest of a
     * member with no active loan at all) is never applied and never hidden: it is returned as unappliedPrincipal /
     * unappliedInterest and shown in the posting message, because the ledger has credited it all the same.
     */
    private async applyDemandRecoveryToLoans(
        queryRunner: { query: (sql: string, params?: any[]) => Promise<any> },
        monthNum: number,
        yearNum: number,
        branch: string | undefined,
        voucherNo: string,
    ): Promise<{ members: number; loanCases: number; principal: number; interest: number; unappliedPrincipal: number; unappliedInterest: number }> {
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

        const summary = { members: 0, loanCases: 0, principal: 0, interest: 0, unappliedPrincipal: 0, unappliedInterest: 0 };
        for (const row of rows) {
            // one loan_repayment_ledger row per loan case: the principal and interest of this run are collected here and written once
            const perLoan = new Map<string, { loancaseno: string; loantype: string; principal: number; interest: number }>();
            const addToLoan = (loancaseno: string, loantype: string, principal: number, interest: number) => {
                const k = `${loancaseno}|${loantype}`;
                const cur = perLoan.get(k) ?? { loancaseno, loantype, principal: 0, interest: 0 };
                cur.principal = round2(cur.principal + principal);
                cur.interest = round2(cur.interest + interest);
                perLoan.set(k, cur);
            };
            let orphanInterest = 0;

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
                if (loans.length === 0) {
                    // no active loan of this type: the principal has no loan to go to (reported), the interest goes to the member's other loan (below)
                    summary.unappliedPrincipal = round2(summary.unappliedPrincipal + principalDemand);
                    orphanInterest = round2(orphanInterest + interestDemand);
                    continue;
                }

                let remaining = principalDemand;
                const allocations: Array<{ loancaseno: string; loantype: string; principal: number }> = [];
                for (const loan of loans) {
                    if (remaining <= 0) break;
                    const applied = round2(Math.min(remaining, Number(loan.balance) || 0));
                    if (applied <= 0) continue;
                    allocations.push({ loancaseno: String(loan.loancaseno), loantype: loan.loantype, principal: applied });
                    remaining = round2(remaining - applied);
                }
                // principal above what the loans still owe is not applied (a balance never goes negative)
                if (remaining > 0) summary.unappliedPrincipal = round2(summary.unappliedPrincipal + remaining);
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
                    addToLoan(a.loancaseno, a.loantype, a.principal, interestShare);
                }
            }

            // ES-590: interest of a type the member has no active loan for goes to the member's other loan
            if (orphanInterest > 0) {
                const first = perLoan.values().next().value as { loancaseno: string; loantype: string } | undefined;
                if (first) {
                    addToLoan(first.loancaseno, first.loantype, 0, orphanInterest);
                } else {
                    const anyLoan = await queryRunner.query(
                        `SELECT loancaseno, loantype FROM loan_master
                          WHERE mbno::text = $1::text AND CAST(balance AS numeric) > 0
                          ORDER BY payment_date ASC, loancaseno ASC
                          LIMIT 1
                          FOR UPDATE`,
                        [String(row.mbno)],
                    );
                    if (anyLoan.length > 0) addToLoan(String(anyLoan[0].loancaseno), anyLoan[0].loantype, 0, orphanInterest);
                    else summary.unappliedInterest = round2(summary.unappliedInterest + orphanInterest);
                }
            }

            for (const l of perLoan.values()) {
                await queryRunner.query(
                    `INSERT INTO loan_repayment_ledger
                        (mbno, loancaseno, loantype, payment_date, payment_month, payment_year, payment_amount,
                         principal_amount, interest_amount, penal_amount, months_overdue,
                         receipt_no, narration, posted_by, payment_source)
                     VALUES ($1, $2, $3, CURRENT_DATE, $4, $5, $6, $7, $8, 0, 0, $9, $10, 'SYSTEM-BULK', 'DEMAND')`,
                    [
                        row.mbno, l.loancaseno, l.loantype, monthNum, yearNum,
                        round2(l.principal + l.interest), l.principal, l.interest,
                        voucherNo, 'Bulk Demand Recovery Posting',
                    ],
                );
                summary.loanCases++;
                summary.principal = round2(summary.principal + l.principal);
                summary.interest = round2(summary.interest + l.interest);
            }
            if (perLoan.size > 0) summary.members++;
        }
        return summary;
    }
}
