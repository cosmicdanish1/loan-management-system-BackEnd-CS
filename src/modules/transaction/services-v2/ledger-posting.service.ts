import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, DataSource } from 'typeorm';
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
            let fetchQuery = `
                SELECT * FROM demand_master
                WHERE demand_for_month = $1 AND demand_for_year = $2
                  AND (demand_posted IS NULL OR demand_posted = 'N')
            `;
            const fetchParams: any[] = [monthNum, yearNum];

            if (dto.branch) {
                fetchQuery += ` AND officeno = $3`;
                fetchParams.push(parseInt(dto.branch) || 0);
            }

            const demandRows = await queryRunner.query(fetchQuery, fetchParams);

            if (demandRows.length === 0) {
                await queryRunner.rollbackTransaction();
                return { success: false, message: 'No unposted demand records found for this period.' };
            }

            // Get next IDs
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
                    const headCodeMap: Record<string, string> = {
                        'RLN': 'A1002', 'ALN': 'A1047', 'OTH': 'L1028',
                        'CD': 'A003', 'MD': 'L1031', 'MD1': 'L1032',
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

                // Update member_balances for loan repayments
                const rlnAmt = parseFloat(row.rln_installment_amount) || 0;
                const elnAmt = parseFloat(row.eln_installment_amount) || 0;
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
                message: `Posted ${demandRows.length} member demands. Total: ₹${totalPosted.toLocaleString('en-IN')}`,
                recordCount: demandRows.length,
                totalPosted,
                voucherNo,
            };
        } catch (error: any) {
            await queryRunner.rollbackTransaction();
            this.logger.error('Ledger posting failed', error);
            throw new Error('Failed to post ledger: ' + error.message);
        } finally {
            await queryRunner.release();
        }
    }
}
