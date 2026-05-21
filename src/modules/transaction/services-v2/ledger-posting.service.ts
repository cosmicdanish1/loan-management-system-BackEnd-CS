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

        // Aggregate query
        // "Head" mapping is conceptual here. In reality, we might have separate lines for 'Regular Loan Principal', 'Regular Loan Interest', etc.
        // For this streamlined implementation, we will summarize into 3 main Categories: 
        // 1. Principal (sum of install amounts)
        // 2. Interest (sum of interest amounts)
        // 3. Savings (RD + Thrift + Share)

        // Using query builder to sum
        const qb = this.demandRepository.createQueryBuilder('dm');
        qb.select([
            // Principal Sums
            'SUM(dm.rln_installment_amount + dm.eln_installment_amount + dm.aln_installment_amount + dm.mln_installment_amount) as principal_total',
            // Interest Sums
            'SUM(dm.rln_interest + dm.eln_interest + dm.aln_interest + dm.mln_interest) as interest_total',
            // Savings Sums
            'SUM(dm.rd_amount + dm.shr_amount + dm.md_amount + dm.cd_amount) as savings_total',
            // Global Totals
            'SUM(dm.totalDemand) as grand_demand',
            'SUM(dm.balance) as grand_balance'
        ])
            .where('dm.demand_for_month = :month', { month: monthNum })
            .andWhere('dm.demand_for_year = :year', { year: yearNum });

        // If branch filter existed in demand_master (e.g. officeno), apply it:
        if (dto.branch) {
            // Mapping branch code to officeno if needed. defaulting to no filter for now unless explicitly needed.
        }

        const res = await qb.getRawOne();

        if (!res) return [];

        // Parse result safely (handling nulls)
        const principalDemand = parseFloat(res.principal_total || '0');
        const interestDemand = parseFloat(res.interest_total || '0');
        const savingsDemand = parseFloat(res.savings_total || '0');

        // Shortfall calculations (Simple ratio based logic for demo as we don't store shortfall per head in a simple way in this table structure)
        // We will assume mostly recovered for demo purposes or proportional distribution of balance
        const totalDemand = parseFloat(res.grand_demand || '0');
        const totalBalance = parseFloat(res.grand_balance || '0');

        if (totalDemand === 0) return [];

        const recoveryRate = 1 - (totalBalance / totalDemand);

        return [
            {
                id: '1',
                headName: 'Loan Principal',
                balance: totalBalance * (principalDemand / totalDemand), // Proportional shortfall
                demandSend: principalDemand,
                demandReceived: principalDemand * recoveryRate,
                shortRecovery: principalDemand * (1 - recoveryRate)
            },
            {
                id: '2',
                headName: 'Loan Interest',
                balance: totalBalance * (interestDemand / totalDemand),
                demandSend: interestDemand,
                demandReceived: interestDemand * recoveryRate,
                shortRecovery: interestDemand * (1 - recoveryRate)
            },
            {
                id: '3',
                headName: 'Savings Contribution',
                balance: totalBalance * (savingsDemand / totalDemand),
                demandSend: savingsDemand,
                demandReceived: savingsDemand * recoveryRate,
                shortRecovery: savingsDemand * (1 - recoveryRate)
            }
        ];
    }

    async postUpdate(dto: LedgerPostingDto) {
        this.logger.log(`Posting ledger update: ${JSON.stringify(dto)}`);

        const monthMap: { [key: string]: number } = {
            'JAN': 1, 'FEB': 2, 'MAR': 3, 'APR': 4, 'MAY': 5, 'JUN': 6,
            'JUL': 7, 'AUG': 8, 'SEP': 9, 'OCT': 10, 'NOV': 11, 'DEC': 12
        };
        const monthNum = monthMap[dto.month] || 0;
        const yearNum = parseInt(dto.year);

        if (!monthNum || !yearNum || dto.totalAmount <= 0) {
            return { success: false, message: 'Invalid parameters for ledger posting.' };
        }

        const queryRunner = this.dataSource.createQueryRunner();
        await queryRunner.connect();
        await queryRunner.startTransaction();

        try {
            const transResult = await queryRunner.query(
                `SELECT COALESCE(MAX(trans_no), 0) + 1 as next_no FROM ledger`
            );
            let transNo = parseInt(transResult[0]?.next_no || '1');

            const transDate = new Date();
            const voucherNo = `GL${dto.month}${dto.year}`;
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

            await queryRunner.query(
                `INSERT INTO ledger (trans_no, trans_date, trans_type, code, mbno, acc_no, acc_type, trans_amt, receipt_vchr_no, vchr_type, modeofpay, pl_balance, narration, username)
                 VALUES ($1, $2, 'DR', $3, 0, 0, $4, $5, $6, 'GL', 'C', 0, $7, 'SYSTEM')`,
                [transNo++, transDate, drCode, accType, dto.totalAmount, voucherNo, narration]
            );

            await queryRunner.query(
                `INSERT INTO ledger (trans_no, trans_date, trans_type, code, mbno, acc_no, acc_type, trans_amt, receipt_vchr_no, vchr_type, modeofpay, pl_balance, narration, username)
                 VALUES ($1, $2, 'CR', $3, 0, 0, $4, $5, $6, 'GL', 'C', 0, $7, 'SYSTEM')`,
                [transNo, transDate, crCode, accType, dto.totalAmount, voucherNo, narration]
            );

            await queryRunner.commitTransaction();

            return {
                success: true,
                message: `Successfully posted ${dto.head} amount ₹${dto.totalAmount} to General Ledger for ${dto.month} ${dto.year}.`
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
