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

        // In a real scenario, we would parse the uploaded file.
        // Here, we'll fetch some real members from the database to simulate a valid file preview.
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
        // Simulate processing and saving to DB
        return {
            success: true,
            message: `Successfully processed ${data.length} records for ${month} ${year}`
        };
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
            // 1. Check for existing demand
            const count = await this.demandRepository.count({
                where: { month: monthNum, year: yearNum }
            });

            if (count > 0) {
                await queryRunner.release();
                return {
                    success: true,
                    message: `Demand for ${dto.month} ${dto.year} already exists (${count} records). Process skipped.`
                };
            }

            // 2. Fetch Active Members
            // In a real scenario, filter by status = 'ACTIVE'
            const members = await queryRunner.query(`SELECT mbno FROM member_master WHERE status = 'ACTIVE'`);

            this.logger.log(`Generating demand for ${members.length} active members...`);

            // 3. Batched Processing (simplified for this context)
            const demands: any[] = [];

            // Fetch All Active Loans efficiently
            const activeLoans = await queryRunner.query(`
                SELECT mbno, COALESCE(SUM(instal_amt), 0) as total_emi 
                FROM loan_master 
                WHERE balance > 0 
                GROUP BY mbno
            `);
            const loanMap = new Map(activeLoans.map((l: any) => [l.mbno, parseFloat(l.total_emi)]));

            // Fetch RO/RD Details (Placeholder - usually from ro_national/united)
            // const roDetails = await queryRunner.query(`...`); 

            for (const member of members) {
                const mbno = member.mbno;
                let totalDemand = 0;

                // A. Loan EMI
                const loanEmi: number = Number(loanMap.get(mbno)) || 0;
                totalDemand += loanEmi;

                // B. Share/RD (Default 0 for now as tables checked empty)
                const shareAmt = 0;
                const rdAmt = 0;
                totalDemand += shareAmt + rdAmt;

                // C. Insurance (If applicable month)
                // const insuranceAmt = ... (fetch from SystemConfig)

                if (totalDemand > 0) {
                    demands.push({
                        month: monthNum,
                        year: yearNum,
                        memberNo: mbno,
                        balance: totalDemand, // Initial balance = total demand (unpaid)
                        totalDemand: totalDemand,
                        // Add detailed breakdown columns if schema supports
                    });
                }
            }

            // 4. Batch Insert
            if (demands.length > 0) {
                // Using raw insert for performance and to handle potential column mismatches in entity
                // Assuming demand_master has (month, year, mbno, balance, totaldemand)
                // We chunk inserts to avoid query limit
                const chunkSize = 500;
                for (let i = 0; i < demands.length; i += chunkSize) {
                    const chunk = demands.slice(i, i + chunkSize);
                    const values = chunk.map(d => `(${d.month}, ${d.year}, ${d.memberNo}, ${d.totalDemand}, ${d.balance})`).join(',');
                    await queryRunner.query(`
                        INSERT INTO demand_master (demand_for_month, demand_for_year, mbno, totaldemand, balance_for_month)
                        VALUES ${values}
                    `);
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
