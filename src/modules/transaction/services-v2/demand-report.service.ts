import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';

export interface DemandListFiltersDto {
    month: string;
    year: string;
    division?: string;
    branch?: string;
    sortBy?: 'Member No.' | 'Name' | 'Account No.';
}

const MONTH_MAP: { [key: string]: number } = {
    'JAN': 1, 'FEB': 2, 'MAR': 3, 'APR': 4, 'MAY': 5, 'JUN': 6,
    'JUL': 7, 'AUG': 8, 'SEP': 9, 'OCT': 10, 'NOV': 11, 'DEC': 12,
};

const SORT_COLUMN: Record<string, string> = {
    'Member No.': 'dm.mbno',
    'Name': 'm.f_name',
    'Account No.': 'dm.mbno', // no separate account number on demand_master; falls back to member number
};

@Injectable()
export class DemandReportService {
    constructor(private readonly dataSource: DataSource) { }

    // BUG FIX: this used to select from demand_master alone and fabricate
    // `memberName: \`Member ${r.memberNo}\`` for every row — confirmed by the
    // code's own comments ("mock names... to make report look good") that it
    // never actually joined member_master, so the printed report could never
    // show a real name. Also: `division` was validated as required by the
    // frontend but never applied to the query at all, and `branch` only ever
    // matched one specific hardcoded fake code ('BR-01') that doesn't
    // correspond to anything real — so every report silently ignored the
    // scope the user picked. Rewritten as a real join against member_master
    // (division → wingno, same column already established for Generate).
    async getDemandList(filters: DemandListFiltersDto) {
        const monthNum = MONTH_MAP[filters.month] || 0;
        const yearNum = parseInt(filters.year);

        const conditions = ['dm.demand_for_month = $1', 'dm.demand_for_year = $2'];
        const params: any[] = [monthNum, yearNum];

        if (filters.division) {
            params.push(filters.division);
            conditions.push(`m.wingno = $${params.length}`);
        }
        if (filters.branch) {
            params.push(parseInt(filters.branch, 10) || 0);
            conditions.push(`dm.officeno = $${params.length}`);
        }

        const sortCol = SORT_COLUMN[filters.sortBy || 'Member No.'] || 'dm.mbno';

        const rows = await this.dataSource.query(
            `SELECT
                dm.dmnd_srno as id, dm.mbno as "memberNo",
                TRIM(COALESCE(m.f_name, '') || ' ' || COALESCE(m.m_name, '') || ' ' || COALESCE(m.l_name, '')) as "memberName",
                dm.demand_for_month as month, dm.demand_for_year as year,
                dm.rln_installment_amount as "rlnInstallmentAmount", dm.rln_interest as "rlnInterest",
                dm.totaldemand as "totalDemand", dm.balance_for_month as balance
             FROM demand_master dm
             LEFT JOIN member_master m ON m.mbno = dm.mbno
             WHERE ${conditions.join(' AND ')}
             ORDER BY ${sortCol} ASC`,
            params,
        );

        return rows.map((r: any) => ({
            ...r,
            memberName: r.memberName?.trim() || `Member ${r.memberNo}`,
            status: Number(r.balance) > 0 ? 'Unpaid' : 'Paid',
        }));
    }
}
