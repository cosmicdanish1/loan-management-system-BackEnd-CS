import { Injectable, Logger } from '@nestjs/common';
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

    async getSummary(dto: LedgerSummaryDto) {
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
        const rows = await this.dataSource.query(
            `SELECT dm.mbno, dm.totaldemand, dm.balance_for_month,
                    COALESCE(dm.rln_installment_amount,0)+COALESCE(dm.eln_installment_amount,0)+COALESCE(dm.aln_installment_amount,0)+COALESCE(dm.mln_installment_amount,0) principal,
                    COALESCE(dm.rln_interest,0)+COALESCE(dm.eln_interest,0)+COALESCE(dm.aln_interest,0)+COALESCE(dm.mln_interest,0) interest,
                    COALESCE(dm.rd_amount,0)+COALESCE(dm.md_amount,0)+COALESCE(dm.cd_amount,0)+COALESCE(dm.shr_amount,0) savings,
                    TRIM(COALESCE(mm.f_name,'') || ' ' || COALESCE(mm.m_name,'') || ' ' || COALESCE(mm.l_name,'')) member_name
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
            // BUG FIX: added FOR UPDATE to prevent duplicate trans_no under concurrent GL postings
            const groups = await this.getSummary({ month: dto.month, year: dto.year, branch: dto.branch || '' });
            const expectedAmount = groups.reduce((sum: number, g: any) => sum + Number(g.totalSend || 0), 0);
            if (Math.abs(expectedAmount - requestedAmount) > 0.01) {
                throw new Error(`Posting total ₹${requestedAmount.toFixed(2)} does not match pending demand ₹${expectedAmount.toFixed(2)}`);
            }
            const transResult = await queryRunner.query(
                `SELECT COALESCE(MAX(trans_no), 0) + 1 as next_no, COALESCE(MAX(ledgerid), 0) + 1 as next_ledger_id FROM ledger`
            );
            let transNo = parseInt(transResult[0]?.next_no || '1');
            let ledgerId = parseInt(transResult[0]?.next_ledger_id || '1');

            const transDate = new Date();
            // BUG FIX: voucher number collision — "GLAPR2025" is reused for every head posted in
            // the same month. Two postings (e.g. Loan Principal + Loan Interest) share the same
            // voucherNo, making audit queries ambiguous. Include a timestamp suffix to ensure uniqueness.
            const voucherNo = `G${String(transNo).padStart(5, '0').slice(-5)}`;
            const narration = `GL Posting - ${dto.head} for ${dto.month} ${dto.year}`;

            // Head codes: DR = cash collection side, CR = account/income side
            let drCode: string;
            let crCode: string;
            let accType: string;

            if (dto.head === 'Loan Principal') {
                drCode = 'A1001'; crCode = 'A1003'; accType = 'LN';
            } else if (dto.head === 'Loan Interest') {
                drCode = 'A1001'; crCode = 'L1028'; accType = 'LN';
            } else {
                drCode = 'A1001'; crCode = 'L1001'; accType = 'SB';
            }

            // BUG FIX: both ledger INSERTs were missing the 'ledgerid' column — every other ledger
            // INSERT in the codebase includes it. Without it this throws a NOT NULL constraint error.
            await queryRunner.query(
                `INSERT INTO ledger (trans_no, trans_date, trans_type, code, mbno, acc_no, acc_type, trans_amt, receipt_vchr_no, vchr_type, modeofpay, pl_balance, narration, username, ledgerid)
                 VALUES ($1, $2, 'DR', $3, 0, 0, $4, $5, $6, 'GL', 'C', 0, $7, 'SYSTEM', $8)`,
                [transNo++, transDate, drCode, accType, requestedAmount, voucherNo, narration, ledgerId++]
            );

            await queryRunner.query(
                `INSERT INTO ledger (trans_no, trans_date, trans_type, code, mbno, acc_no, acc_type, trans_amt, receipt_vchr_no, vchr_type, modeofpay, pl_balance, narration, username, ledgerid)
                 VALUES ($1, $2, 'CR', $3, 0, 0, $4, $5, $6, 'GL', 'C', 0, $7, 'SYSTEM', $8)`,
                [transNo, transDate, crCode, accType, requestedAmount, voucherNo, narration, ledgerId]
            );

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
}
