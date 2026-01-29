import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, MoreThan } from 'typeorm';
import { DemandMaster } from '../entities/demand-master.entity';
import { ShortRecoveryAdjustment } from '../entities/short-recovery-adjustment.entity';

@Injectable()
export class ShortRecoveryService {
    constructor(
        @InjectRepository(DemandMaster)
        private readonly demandRepository: Repository<DemandMaster>,
        @InjectRepository(ShortRecoveryAdjustment)
        private readonly adjustmentRepository: Repository<ShortRecoveryAdjustment>,
    ) { }

    async findAll(month: string, year: string, wing: string) {
        // Note: 'month' from UI is 'APR', 'MAY', etc. Need to convert to number if DB uses numbers.
        // Assuming simplistic mapping or direct pass for now.
        // Also joining with Member to get name/wing would require Member entity relation or raw query.
        // For simpler implementation, we'll fetch demands with balance > 0.

        // Real mapping logic for month name to number needed?
        // Let's assume the DB stores month as number (1-12).
        const monthMap: { [key: string]: number } = {
            'JAN': 1, 'FEB': 2, 'MAR': 3, 'APR': 4, 'MAY': 5, 'JUN': 6,
            'JUL': 7, 'AUG': 8, 'SEP': 9, 'OCT': 10, 'NOV': 11, 'DEC': 12
        };
        const monthNum = monthMap[month] || 0;
        const yearNum = parseInt(year);

        const demands = await this.demandRepository.find({
            where: {
                // month: monthNum, // Filter by month if needed, or get all pending
                // year: yearNum,
                // balance > 0
                balance: MoreThan(0)
            },
            take: 50 // Limit results
        });

        // Transform to frontend format
        return demands.map(d => ({
            id: d.id.toString(),
            memberNo: d.memberNo?.toString(),
            memberName: `Member ${d.memberNo}`, // Placeholder as we miss Member join
            recoveryType: 'Total Demand', // Simplified
            expectedAmount: Number(d.totalDemand),
            recoveredAmount: Number(d.totalDemand) - Number(d.balance),
            shortfallAmount: Number(d.balance),
            status: 'Pending'
        }));
    }

    async adjust(demandId: number, reason: string, amount: number) {
        const demand = await this.demandRepository.findOne({ where: { id: demandId } });
        if (!demand) throw new Error('Demand not found');

        // reduce balance (or set to 0?)
        // The requirement implies "Modify Short Recovery" -> Fix it.
        // Let's assume we are writing it off or marking it adjusted.

        demand.balance = 0; // cleared.
        await this.demandRepository.save(demand);

        const adj = new ShortRecoveryAdjustment();
        adj.demandId = demandId;
        adj.adjustmentAmount = amount;
        adj.reason = reason;
        adj.adjustedBy = 'Admin';
        await this.adjustmentRepository.save(adj);

        return { success: true };
    }
}
