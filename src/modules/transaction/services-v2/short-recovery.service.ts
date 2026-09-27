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

        if (!monthNum || !yearNum) return [];
        const params: any[] = [monthNum, yearNum];
        const conditions = ['dm.balance_for_month > 0', 'dm.demand_for_month = $1', 'dm.demand_for_year = $2'];
        if (wing) {
            params.push(wing);
            conditions.push(`mm.wingno::text = $${params.length}`);
        }
        const rawResults = await this.dataSource.query(
            `SELECT dm.dmnd_srno as serial, dm.mbno as "memberNo",
                    dm.demand_for_month as month, dm.demand_for_year as year,
                    dm.totaldemand as "totalDemand", dm.balance_for_month as balance,
                    mm.f_name as "fName", mm.m_name as "mName", mm.l_name as "lName"
             FROM demand_master dm
             LEFT JOIN member_master mm ON mm.mbno = dm.mbno
             WHERE ${conditions.join(' AND ')}
             ORDER BY dm.mbno`,
            params,
        );

        return rawResults.map(r => ({
            // dmnd_srno is historically zero for legacy rows, so the
            // period/member composite is the only reliable row identity.
            id: `${r.year}-${r.month}-${r.memberNo}`,
            memberNo: r.memberNo?.toString(),
            memberName: `${r.fName || ''} ${r.lName || ''}`.trim() || `Member ${r.memberNo}`,
            recoveryType: 'Demand Shortfall',
            expectedAmount: Number(r.totalDemand),
            recoveredAmount: Number(r.totalDemand) - Number(r.balance),
            shortfallAmount: Number(r.balance),
            status: 'Pending'
        }));
    }

    async adjust(demandId: string, reason: string, amount: number) {
        // BUG FIX: the original code had TWO separate saves with no transaction between them.
        // If adjustmentRepository.save() failed, demand.balance was already set to 0 with no
        // adjustment record created — split-brain state: balance zeroed but no audit trail.
        // Fix: wrap both saves in a single queryRunner transaction so they succeed or fail together.
        const queryRunner = this.dataSource.createQueryRunner();
        await queryRunner.connect();
        await queryRunner.startTransaction();

        try {
            if (!reason?.trim() || !Number.isFinite(Number(amount)) || Number(amount) <= 0) {
                throw new Error('A reason and positive adjustment amount are required');
            }
            const [year, month, memberNo] = String(demandId).split('-');
            if (!year || !month || !memberNo) throw new Error('Invalid demand identifier');
            const demandRows = await queryRunner.query(
                `SELECT dmnd_srno, totaldemand, balance_for_month
                 FROM demand_master
                 WHERE demand_for_year = $1 AND demand_for_month = $2 AND mbno = $3
                 FOR UPDATE`,
                [Number(year), Number(month), memberNo],
            );
            const demand = demandRows[0];
            if (!demand) throw new Error('Demand not found');
            if (Number(amount) > Number(demand.balance_for_month)) {
                throw new Error('Adjustment amount cannot exceed the shortfall');
            }

            // Zero out the shortfall balance
            const remaining = Number(demand.balance_for_month) - Number(amount);
            await queryRunner.query(
                `UPDATE demand_master SET balance_for_month = $1
                 WHERE demand_for_year = $2 AND demand_for_month = $3 AND mbno = $4`,
                [remaining, Number(year), Number(month), memberNo],
            );

            // Record the adjustment for audit trail
            const adj = new ShortRecoveryAdjustment();
            adj.demandId = Number(demand.dmnd_srno) || 0;
            adj.adjustmentAmount = amount;
            adj.reason = reason;
            adj.adjustedBy = 'system-user';
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
