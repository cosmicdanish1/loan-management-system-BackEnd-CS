import { Injectable, BadRequestException, NotFoundException } from '@nestjs/common';
import { DataSource, QueryRunner } from 'typeorm';
import { RdRulesService } from '../rd-rules.service';

export interface RdMemberConfigHistoryRow {
    id: number;
    monthlyRdAmount: number;
    effectiveFromDate: string;
    setBy: string | null;
    createdAt: string;
}

/**
 * A member's chosen monthly RD amount, per financial year, kept as an
 * append-only history (mid-year changes are allowed per the user, so
 * "current amount" = the latest row by effective_from_date <= today for
 * that member+year — never an in-place update, so past periods stay exactly
 * as they were when the amount changes).
 */
@Injectable()
export class RdMemberConfigService {
    constructor(
        private readonly dataSource: DataSource,
        private readonly rdRules: RdRulesService,
    ) { }

    async setMonthlyAmount(
        mbno: string,
        yearcode: number,
        monthlyRdAmount: number,
        setBy: string,
        effectiveFromDate?: Date,
        externalQueryRunner?: QueryRunner,
    ): Promise<void> {
        // Runs on the caller's own transaction connection when given one —
        // needed so this can be called as part of a NEW member's creation
        // transaction (member-crud.service.ts), where the member row exists
        // only within that same uncommitted transaction and would be
        // invisible to a fresh connection via the plain DataSource.
        const runner: { query: (sql: string, params?: any[]) => Promise<any> } = externalQueryRunner ?? this.dataSource;

        const member = await runner.query(
            `SELECT mbno FROM member_master WHERE CAST(mbno AS text) = $1`,
            [mbno],
        );
        if (member.length === 0) {
            throw new NotFoundException(`Member ${mbno} not found`);
        }

        const minAmount = await this.rdRules.getRule('RULE_RD_MIN_MONTHLY_AMOUNT');
        if (monthlyRdAmount < minAmount) {
            throw new BadRequestException(
                `Monthly RD amount must be at least ₹${minAmount.toLocaleString('en-IN')}`,
            );
        }

        const yearRows = await runner.query(
            `SELECT yearcode FROM yearend WHERE yearcode = $1`,
            [yearcode],
        );
        if (yearRows.length === 0) {
            throw new BadRequestException(`Financial year ${yearcode} does not exist`);
        }

        await runner.query(
            `INSERT INTO rd_member_config (mbno, yearcode, monthly_rd_amount, effective_from_date, set_by)
             VALUES ($1, $2, $3, COALESCE($4, CURRENT_DATE), $5)`,
            [mbno, yearcode, monthlyRdAmount, effectiveFromDate ?? null, setBy],
        );
    }

    /** The amount actually in effect for a member+year as of a given date
     *  (defaults to today) — the figure Demand Generation should use when
     *  building that month's rd_amount, and what the installment ledger's
     *  "expected_amount" should be populated from. */
    async getCurrentAmount(mbno: string, yearcode: number, asOfDate?: Date): Promise<number> {
        const asOf = asOfDate ?? new Date();
        const rows = await this.dataSource.query(
            `SELECT monthly_rd_amount FROM rd_member_config
             WHERE mbno = $1 AND yearcode = $2 AND effective_from_date <= $3
             ORDER BY effective_from_date DESC, id DESC LIMIT 1`,
            [mbno, yearcode, asOf],
        );
        return rows[0] ? Number(rows[0].monthly_rd_amount) : 0;
    }

    async getHistory(mbno: string, yearcode: number): Promise<RdMemberConfigHistoryRow[]> {
        const rows = await this.dataSource.query(
            `SELECT id, monthly_rd_amount, effective_from_date, set_by, created_at
             FROM rd_member_config
             WHERE mbno = $1 AND yearcode = $2
             ORDER BY effective_from_date ASC, id ASC`,
            [mbno, yearcode],
        );
        return rows.map((r: any) => ({
            id: r.id,
            monthlyRdAmount: Number(r.monthly_rd_amount),
            effectiveFromDate: r.effective_from_date,
            setBy: r.set_by,
            createdAt: r.created_at,
        }));
    }
}
