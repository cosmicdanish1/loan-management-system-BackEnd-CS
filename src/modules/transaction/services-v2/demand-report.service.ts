import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';

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
        private readonly dataSource: DataSource,
    ) { }

    async getDemandList(filters: DemandListFiltersDto) {
        const monthMap: { [key: string]: number } = {
            'JAN': 1, 'FEB': 2, 'MAR': 3, 'APR': 4, 'MAY': 5, 'JUN': 6,
            'JUL': 7, 'AUG': 8, 'SEP': 9, 'OCT': 10, 'NOV': 11, 'DEC': 12
        };
        const monthNum = monthMap[filters.month] || 0;
        const yearNum = parseInt(filters.year);

        if (!monthNum || !yearNum) return [];

        const params: any[] = [monthNum, yearNum];
        const conditions = ['dm.demand_for_month = $1', 'dm.demand_for_year = $2'];
        if (filters.division) {
            params.push(filters.division);
            conditions.push(`mm.wingno::text = $${params.length}`);
        }
        if (filters.branch) {
            params.push(filters.branch);
            conditions.push(`dm.officeno::text = $${params.length}`);
        }

        const orderBy = filters.sortBy === 'Name'
            ? 'member_name ASC'
            : filters.sortBy === 'Account No.'
                ? 'dm.loancaseno ASC NULLS LAST'
                : 'dm.mbno ASC';
        const results = await this.dataSource.query(
            `SELECT dm.dmnd_srno as id, dm.mbno as "memberNo",
                    dm.demand_for_month as month, dm.demand_for_year as year,
                    dm.rln_installment_amount as "rlnInstallmentAmount",
                    dm.rln_interest as "rlnInterest",
                    dm.totaldemand as "totalDemand",
                    dm.balance_for_month as balance,
                    dm.officeno as "officeNo", dm.loancaseno as "loanCaseNo",
                    TRIM(COALESCE(mm.f_name,'') || ' ' || COALESCE(mm.m_name,'') || ' ' || COALESCE(mm.l_name,'')) as member_name,
                    CASE WHEN COALESCE(dm.balance_for_month,0) > 0 THEN 'Unpaid' ELSE 'Paid' END as status
             FROM demand_master dm
             LEFT JOIN member_master mm ON mm.mbno = dm.mbno
             WHERE ${conditions.join(' AND ')}
             ORDER BY ${orderBy}`,
            params,
        );

        return results.map((r: any) => ({
            ...r,
            memberName: r.member_name || `Member ${r.memberNo}`,
        }));
    }
}
