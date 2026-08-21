import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, MoreThan, DataSource } from 'typeorm';
import { DemandMaster } from '../entities/demand-master.entity';
import { ShortRecoveryAdjustment } from '../entities/short-recovery-adjustment.entity';
import { MemberMaster } from '../../member/entities/member-master.entity';

@Injectable()
export class ShortRecoveryService {
    constructor(
        @InjectRepository(DemandMaster)
        private readonly demandRepository: Repository<DemandMaster>,
        @InjectRepository(ShortRecoveryAdjustment)
        private readonly adjustmentRepository: Repository<ShortRecoveryAdjustment>,
        private readonly dataSource: DataSource,
    ) { }

    async findAll(month: string, year: string, wing: string) {
        const monthMap: { [key: string]: number } = {
            'JAN': 1, 'FEB': 2, 'MAR': 3, 'APR': 4, 'MAY': 5, 'JUN': 6,
            'JUL': 7, 'AUG': 8, 'SEP': 9, 'OCT': 10, 'NOV': 11, 'DEC': 12
        };
        const monthNum = monthMap[month] || 0;
        const yearNum = parseInt(year);

        const qb = this.demandRepository.createQueryBuilder('dm');
        qb.leftJoin(MemberMaster, 'mm', 'dm.memberNo = CAST(mm.mbno AS NUMERIC)');

        qb.select('dm.id', 'id')
            .addSelect('dm.memberNo', 'memberNo')
            .addSelect('mm.f_name', 'fName')
            .addSelect('mm.m_name', 'mName')
            .addSelect('mm.l_name', 'lName')
            .addSelect('dm.totalDemand', 'totalDemand')
            .addSelect('dm.balance', 'balance');

        qb.where('dm.balance > 0');
        if (monthNum) qb.andWhere('dm.month = :month', { month: monthNum });
        if (yearNum) qb.andWhere('dm.year = :year', { year: yearNum });
        // BUG FIX: `wing` was accepted as a parameter but never actually applied —
        // every call returned every member's shortfall regardless of the wing
        // picked in the UI. mm.wingno is the same real column already
        // established for Generate/Print Members Demand List.
        if (wing) qb.andWhere('mm.wingno = :wing', { wing });

        const rawResults = await qb.getRawMany();

        return rawResults.map(r => ({
            id: r.id.toString(),
            memberNo: r.memberNo?.toString(),
            memberName: `${r.fName || ''} ${r.lName || ''}`.trim() || `Member ${r.memberNo}`,
            recoveryType: 'Demand Shortfall',
            expectedAmount: Number(r.totalDemand),
            recoveredAmount: Number(r.totalDemand) - Number(r.balance),
            shortfallAmount: Number(r.balance),
            status: 'Pending'
        }));
    }

    async adjust(demandId: number, reason: string, amount: number) {
        // BUG FIX: the original code had TWO separate saves with no transaction between them.
        // If adjustmentRepository.save() failed, demand.balance was already set to 0 with no
        // adjustment record created — split-brain state: balance zeroed but no audit trail.
        // Fix: wrap both saves in a single queryRunner transaction so they succeed or fail together.
        const queryRunner = this.dataSource.createQueryRunner();
        await queryRunner.connect();
        await queryRunner.startTransaction();

        try {
            const demand = await queryRunner.manager.findOne(DemandMaster, { where: { id: demandId } });
            if (!demand) throw new Error('Demand not found');

            // Zero out the shortfall balance
            demand.balance = 0;
            await queryRunner.manager.save(DemandMaster, demand);

            // Record the adjustment for audit trail
            const adj = new ShortRecoveryAdjustment();
            adj.demandId = demandId;
            adj.adjustmentAmount = amount;
            adj.reason = reason;
            adj.adjustedBy = 'Admin';
            await queryRunner.manager.save(ShortRecoveryAdjustment, adj);

            await queryRunner.commitTransaction();
            return { success: true };
        } catch (error: any) {
            await queryRunner.rollbackTransaction();
            throw new Error('Failed to adjust short recovery: ' + error.message);
        } finally {
            await queryRunner.release();
        }
    }
}
