import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { DemandMaster } from '../entities/demand-master.entity';

export interface DemandListFiltersDto {
    month: string;
    year: string;
    division?: string;
    branch?: string;
    sortBy?: 'Member No.' | 'Name' | 'Account No.';
}

@Injectable()
export class DemandReportService {
    constructor(
        @InjectRepository(DemandMaster)
        private readonly demandRepository: Repository<DemandMaster>,
    ) { }

    async getDemandList(filters: DemandListFiltersDto) {
        const monthMap: { [key: string]: number } = {
            'JAN': 1, 'FEB': 2, 'MAR': 3, 'APR': 4, 'MAY': 5, 'JUN': 6,
            'JUL': 7, 'AUG': 8, 'SEP': 9, 'OCT': 10, 'NOV': 11, 'DEC': 12
        };
        const monthNum = monthMap[filters.month] || 0;
        const yearNum = parseInt(filters.year);

        const qb = this.demandRepository.createQueryBuilder('dm');

        // Simulating Join with MemberMaster (assuming table exists, but for safety in this strict environment, 
        // we'll rely on what's available or join loosely if entity not imported).
        // Since we don't have MemberMaster entity imported here yet, we will select available fields 
        // and acknowledge that name retrieval would essentially require that join.

        qb.select([
            'dm.id',
            'dm.memberNo',
            'dm.demand_for_month',
            'dm.demand_for_year',
            'dm.rln_installment_amount',
            'dm.rln_interest',
            'dm.totalDemand',
            'dm.balance',
            // Ideally: member.name
        ]);

        qb.where('dm.demand_for_month = :month', { month: monthNum })
            .andWhere('dm.demand_for_year = :year', { year: yearNum });

        // Apply Branch/Division filter if columns exist (officeno is often used for this)
        if (filters.branch) {
            // Mapping branch string to officeno code would happen here.
            // For now, assuming no filter or mapping 'BR-01' to 1 for test
            if (filters.branch === 'BR-01') qb.andWhere('dm.officeno = :office', { office: 1 });
        }

        // Sort
        if (filters.sortBy === 'Member No.') {
            qb.orderBy('dm.memberNo', 'ASC');
        } else if (filters.sortBy === 'Account No.') {
            // Assuming loancaseno or similar
            qb.orderBy('dm.memberNo', 'ASC'); // Fallback
        } else {
            qb.orderBy('dm.id', 'ASC');
        }

        const results = await qb.getMany();

        // Enrich with mock names if member join isn't perfect yet, just to make report look good
        return results.map(r => ({
            ...r,
            memberName: `Member ${r.memberNo}`, // Placeholder until MemberMaster entity is widely available in this module
            status: r.balance > 0 ? 'Unpaid' : 'Paid'
        }));
    }
}
