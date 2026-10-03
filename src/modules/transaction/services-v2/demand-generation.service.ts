import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, DataSource } from 'typeorm';
import { DemandMaster } from '../entities/demand-master.entity';

// Interfaces for input/output
export interface DemandGenerationDto {
    month: string;
    year: string;
    divisionRO: string;
    from?: string;
    to?: string;
    /** Optional exact member scope used by controlled test runs and admin tools. */
    memberNos?: string[];
}

@Injectable()
export class DemandGenerationService {
    private readonly logger = new Logger(DemandGenerationService.name);

    constructor(
        @InjectRepository(DemandMaster)
        private readonly demandRepository: Repository<DemandMaster>,
        private readonly dataSource: DataSource,
    ) { }

    async generateDemand(dto: DemandGenerationDto) {
        this.logger.log(`Starting demand generation for ${dto.month} ${dto.year}`);

        const monthMap: { [key: string]: number } = {
            'JAN': 1, 'FEB': 2, 'MAR': 3, 'APR': 4, 'MAY': 5, 'JUN': 6,
            'JUL': 7, 'AUG': 8, 'SEP': 9, 'OCT': 10, 'NOV': 11, 'DEC': 12
        };
        const monthNum = monthMap[dto.month] || 0;
        const yearNum = parseInt(dto.year);

        if (!monthNum || !yearNum) {
            throw new Error('Invalid date parameters');
        }

        const queryRunner = this.dataSource.createQueryRunner();
        await queryRunner.connect();
        await queryRunner.startTransaction();

        try {
            // BUG FIX 1: The count check was done OUTSIDE the transaction using `this.demandRepository.count`,
            // then the queryRunner was released with an open transaction on early return.
            // Fix: move the duplicate check INSIDE the queryRunner transaction and use FOR UPDATE
            // to prevent two concurrent requests both seeing count=0 and both inserting.
            await queryRunner.query('LOCK TABLE demand_master IN SHARE ROW EXCLUSIVE MODE');
            const countResult = await queryRunner.query(
                `SELECT COUNT(*) as cnt FROM demand_master WHERE demand_for_month = $1 AND demand_for_year = $2`,
                [monthNum, yearNum]
            );
            const count = parseInt(countResult[0]?.cnt || '0');

            if (count > 0) {
                // BUG FIX 2: Original code called queryRunner.release() here without committing or
                // rolling back the open transaction first, leaving a dangling transaction on the connection.
                await queryRunner.rollbackTransaction();
                return {
                    success: true,
                    message: `Demand for ${dto.month} ${dto.year} already exists (${count} records). Process skipped.`
                };
            }

            // Fetch Active Members
            const members = await queryRunner.query(
                `SELECT mbno, officeno FROM member_master
                 WHERE COALESCE(isactive, 'Y') <> 'N'
                 AND ($1 = '' OR officeno::text = $1)
                 AND ($2::text[] IS NULL OR CAST(mbno AS text) = ANY($2::text[]))`,
                [dto.divisionRO || '',
                    Array.isArray(dto.memberNos) && dto.memberNos.length > 0
                        ? dto.memberNos.map(String)
                        : null]
            );

            this.logger.log(`Generating demand for ${members.length} active members...`);

            const demands: any[] = [];

            // Fetch All Active Loans efficiently
            const activeLoans = await queryRunner.query(`
                SELECT mbno, COALESCE(SUM(instal_amt), 0) as total_emi
                FROM loan_master
                WHERE balance > 0
                GROUP BY mbno
            `);
            // pg can return numeric member IDs as strings while a grouped
            // query may return the same IDs as numbers. Normalize both sides
            // so every selected member receives its calculated demand.
            const loanMap = new Map(activeLoans.map((l: any) => [String(l.mbno), parseFloat(l.total_emi)]));

            for (const member of members) {
                const mbno = String(member.mbno);
                const loanEmi: number = Number(loanMap.get(mbno)) || 0;
                const totalDemand = loanEmi; // Add more heads (RD, shares, insurance) as needed

                if (totalDemand > 0) {
                    demands.push({
                        month: monthNum,
                        year: yearNum,
                        memberNo: mbno,
                        officeNo: member.officeno,
                        balance: totalDemand,
                        totalDemand: totalDemand,
                    });
                }
            }

            // BUG FIX 3: Original code built SQL via string interpolation:
            //   `VALUES ${chunk.map(d => `(${d.month}, ${d.year}, ${d.memberNo}, ...)`).join(',')}`
            // This is a SQL injection risk and will crash with a SQL syntax error if any value is
            // null, undefined, or NaN (e.g. if totalDemand is NaN → "VALUES (..., NaN, ...)" is invalid SQL).
            // Fix: use individual parameterized INSERTs per record, which is safe and correct.
            if (demands.length > 0) {
                const serialResult = await queryRunner.query(
                    'SELECT COALESCE(MAX(dmnd_srno), 0) + 1 AS next_serial FROM demand_master',
                );
                let nextSerial = Number(serialResult[0]?.next_serial || 1);
                for (const d of demands) {
                    await queryRunner.query(
                        `INSERT INTO demand_master (
                           demand_for_month, demand_for_year, mbno, officeno, dmnd_srno,
                           demand_posted, sd, passflag, receipt_vchr_no,
                           rln_installment_amount, totaldemand, balance_for_month
                         ) VALUES ($1,$2,$3,$4,$5,'N','N','N','',$6,$6,$6)`,
                        [d.month, d.year, d.memberNo, d.officeNo, nextSerial++, d.totalDemand]
                    );
                }
            }

            await queryRunner.commitTransaction();

            return {
                success: true,
                message: `Successfully generated demand for ${demands.length} members for ${dto.month} ${dto.year}.`
            };

        } catch (error: any) {
            await queryRunner.rollbackTransaction();
            this.logger.error('Demand generation failed', error);
            throw new Error('Failed to generate demand: ' + error.message);
        } finally {
            await queryRunner.release();
        }
    }
}
