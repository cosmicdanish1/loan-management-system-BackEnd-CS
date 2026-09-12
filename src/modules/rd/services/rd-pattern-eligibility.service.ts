import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { RdRulesService } from '../rd-rules.service';
import { evaluateRdPaymentPattern, PatternEvaluation, InstallmentRecord } from '../rd-pattern-engine';

/**
 * Reads a member's rd_installment_ledger rows for a financial year and runs
 * them through the pattern engine, using the currently configured RdRules.
 * This is the only place that bridges the DB shape to the pure-function
 * engine — the engine itself stays unit-testable without a database.
 */
@Injectable()
export class RdPatternEligibilityService {
    constructor(
        private readonly dataSource: DataSource,
        private readonly rdRules: RdRulesService,
    ) { }

    async getInstallmentRecords(mbno: string, yearcode: number): Promise<InstallmentRecord[]> {
        const rows = await this.dataSource.query(
            `SELECT due_date, expected_amount, paid_amount, paid_date
             FROM rd_installment_ledger
             WHERE mbno = $1 AND yearcode = $2
             ORDER BY due_date ASC`,
            [mbno, yearcode],
        );
        return rows.map((r: any) => ({
            dueDate: r.due_date,
            expectedAmount: Number(r.expected_amount),
            paidAmount: Number(r.paid_amount),
            paidDate: r.paid_date,
        }));
    }

    async evaluateMember(mbno: string, yearcode: number): Promise<PatternEvaluation> {
        const [records, rules] = await Promise.all([
            this.getInstallmentRecords(mbno, yearcode),
            this.rdRules.getAllRules(),
        ]);
        return evaluateRdPaymentPattern(records, rules);
    }
}
