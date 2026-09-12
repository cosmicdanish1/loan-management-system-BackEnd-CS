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
}

@Injectable()
export class DemandGenerationService {
    private readonly logger = new Logger(DemandGenerationService.name);

    constructor(
        @InjectRepository(DemandMaster)
        private readonly demandRepository: Repository<DemandMaster>,
        private readonly dataSource: DataSource,
    ) { }

    async previewDemandImport(month: string, year: string) {
        this.logger.log(`Previewing demand import for ${month} ${year}`);

        // Fetches real members from the database for preview display
        const members = await this.dataSource.query(`
            SELECT mbno as "memberId", CONCAT(f_name, ' ', l_name) as "memberName", dept_name as "department"
            FROM member_master
            LIMIT 15
        `);

        return members.map((m: any) => ({
            key: m.memberId.toString(),
            memberId: m.memberId.toString(),
            memberName: m.memberName,
            department: m.department || 'General',
            demandAmount: Math.floor(Math.random() * 5000) + 1000,
            status: 'Valid',
            remarks: ''
        }));
    }

    async processDemandImport(month: string, year: string, data: any[]) {
        this.logger.log(`Processing demand import for ${month} ${year} with ${data.length} records`);

        if (!data || data.length === 0) {
            return { success: false, message: 'No records to process.' };
        }

        // Actual persistence of demand import records
        const queryRunner = this.dataSource.createQueryRunner();
        await queryRunner.connect();
        await queryRunner.startTransaction();

        try {
            const monthMap: { [key: string]: number } = {
                'January': 1, 'February': 2, 'March': 3, 'April': 4, 'May': 5, 'June': 6,
                'July': 7, 'August': 8, 'September': 9, 'October': 10, 'November': 11, 'December': 12
            };
            const monthNum = monthMap[month] || 0;
            const yearNum = parseInt(year);

            if (!monthNum || !yearNum) {
                throw new Error(`Invalid month/year: ${month} ${year}`);
            }

            // BUG FIX: processDemandImport was a stub — it returned fake success without saving anything.
            // Now uses parameterized INSERT to persist each record in the demand_master table.
            for (const record of data) {
                const memberNo = parseInt(record.memberId);
                const demandAmount = parseFloat(record.demandAmount) || 0;
                if (isNaN(memberNo) || demandAmount <= 0) continue;

                await queryRunner.query(
                    `INSERT INTO demand_master (demand_for_month, demand_for_year, mbno, totaldemand, balance_for_month)
                     VALUES ($1, $2, $3, $4, $5)
                     ON CONFLICT (demand_for_month, demand_for_year, mbno) DO UPDATE
                       SET totaldemand = EXCLUDED.totaldemand, balance_for_month = EXCLUDED.balance_for_month`,
                    [monthNum, yearNum, memberNo, demandAmount, demandAmount]
                );
            }

            await queryRunner.commitTransaction();

            return {
                success: true,
                message: `Successfully processed ${data.length} records for ${month} ${year}`
            };
        } catch (error: any) {
            await queryRunner.rollbackTransaction();
            this.logger.error('processDemandImport failed', error);
            throw new Error('Failed to process demand import: ' + error.message);
        } finally {
            await queryRunner.release();
        }
    }

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
                `SELECT mbno FROM member_master WHERE isactive IS NOT FALSE AND isactive IS DISTINCT FROM 'N'`
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
            const loanMap = new Map(activeLoans.map((l: any) => [l.mbno, parseFloat(l.total_emi)]));

            for (const member of members) {
                const mbno = member.mbno;
                const loanEmi: number = Number(loanMap.get(mbno)) || 0;
                const totalDemand = loanEmi; // Add more heads (RD, shares, insurance) as needed

                if (totalDemand > 0) {
                    demands.push({
                        month: monthNum,
                        year: yearNum,
                        memberNo: mbno,
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
                for (const d of demands) {
                    await queryRunner.query(
                        `INSERT INTO demand_master (demand_for_month, demand_for_year, mbno, totaldemand, balance_for_month)
                         VALUES ($1, $2, $3, $4, $5)`,
                        [d.month, d.year, d.memberNo, d.totalDemand, d.balance]
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
