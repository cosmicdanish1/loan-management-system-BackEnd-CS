import { Injectable, BadRequestException } from '@nestjs/common';
import { DataSource, QueryRunner } from 'typeorm';
import { RdBalanceEventsService } from './rd-balance-events.service';
import { RdRulesService } from '../rd-rules.service';

export interface RdLienRow {
    id: number;
    mbno: string;
    loanCaseNo: string;
    lienAmount: number;
    status: 'ACTIVE' | 'RELEASED';
    placedAt: string;
    placedBy: string | null;
    releasedAt: string | null;
    releasedBy: string | null;
    releaseReason: string | null;
}

/**
 * Locks part of a member's RD as security for a Loan Against RD (loan type ELN).
 *
 * RD money is tracked per member per financial year, so a lien is a member-level
 * amount (table rd_lien), not a link to an account number. The amount locked is
 * the loan amount — never the whole RD — so the rest of the RD stays free.
 * Free RD = total holdings - SUM(active liens); the eligibility rule reads it to
 * size the next loan and the RD withdrawal path reads it to refuse taking locked
 * money out. A lien is never deleted: release() only flips it to RELEASED.
 *
 * Both write methods accept the caller's QueryRunner so a lien placed at loan
 * disbursement commits or rolls back together with the loan itself.
 */
@Injectable()
export class RdLienService {
    constructor(
        private readonly dataSource: DataSource,
        private readonly rdBalanceEvents: RdBalanceEventsService,
        private readonly rdRules: RdRulesService,
    ) { }

    /** Total RD currently locked for this member by ACTIVE liens. */
    async getLockedAmount(mbno: string, queryRunner?: QueryRunner): Promise<number> {
        const rows = await (queryRunner ?? this.dataSource).query(
            `SELECT COALESCE(SUM(lien_amount), 0) AS total FROM rd_lien WHERE mbno = $1 AND status = 'ACTIVE'`,
            [mbno],
        );
        return Number(rows[0]?.total || 0);
    }

    /** Every lien (active and released) for a member, newest first. */
    async getMemberLiens(mbno: string): Promise<RdLienRow[]> {
        const rows = await this.dataSource.query(
            `SELECT id, mbno, loancaseno, lien_amount, status, placed_at, placed_by,
                    released_at, released_by, release_reason
               FROM rd_lien WHERE mbno = $1 ORDER BY id DESC`,
            [mbno],
        );
        return rows.map((r: any) => ({
            id: r.id,
            mbno: String(r.mbno),
            loanCaseNo: r.loancaseno,
            lienAmount: Number(r.lien_amount),
            status: r.status,
            placedAt: r.placed_at,
            placedBy: r.placed_by,
            releasedAt: r.released_at,
            releasedBy: r.released_by,
            releaseReason: r.release_reason,
        }));
    }

    /**
     * Lock `amount` of the member's RD for a loan case.
     *
     * Safe to call again for the same case with the same amount (returns the
     * existing lien); a different amount for a case that is already locked is
     * refused. As a hard backstop it also refuses to lock more than the RD can
     * carry once the minimum balance is kept — the 90% / ₹5 lakh policy itself
     * lives in LoanEligibilityService, which runs before this.
     */
    async place(
        params: { mbno: string; loanCaseNo: string; amount: number; placedBy: string },
        externalQueryRunner?: QueryRunner,
    ): Promise<{ id: number; lienAmount: number; alreadyLocked: boolean }> {
        const { mbno, loanCaseNo, placedBy } = params;
        const amount = Math.round(params.amount * 100) / 100;
        if (!(amount > 0)) throw new BadRequestException('RD lien amount must be greater than zero.');

        const queryRunner = externalQueryRunner ?? this.dataSource.createQueryRunner();
        const ownsTransaction = !externalQueryRunner;
        if (ownsTransaction) {
            await queryRunner.connect();
            await queryRunner.startTransaction();
        }
        try {
            const yearcode = await this.getCurrentYearcode(queryRunner);
            if (!yearcode) throw new BadRequestException('No current financial year is set up, so RD cannot be locked.');

            // Serialise with other lien writes for this member, and with RD
            // withdrawals (same key recordWithdrawal() uses), so a withdrawal
            // can't slip in between our balance read and the insert.
            await queryRunner.query(`SELECT pg_advisory_xact_lock(hashtext('rd_lien_' || $1))`, [mbno]);
            await queryRunner.query(
                `SELECT pg_advisory_xact_lock(hashtext('rd_balance_' || $1 || '_' || $2))`,
                [mbno, String(yearcode)],
            );

            const existing = await queryRunner.query(
                `SELECT id, lien_amount FROM rd_lien WHERE loancaseno = $1 AND status = 'ACTIVE'`,
                [loanCaseNo],
            );
            if (existing.length > 0) {
                const have = Number(existing[0].lien_amount);
                if (have !== amount) {
                    throw new BadRequestException(
                        `Loan case ${loanCaseNo} already has ₹${have.toLocaleString('en-IN')} of RD locked; ` +
                        `it cannot be locked again for ₹${amount.toLocaleString('en-IN')}.`,
                    );
                }
                if (ownsTransaction) await queryRunner.commitTransaction();
                return { id: existing[0].id, lienAmount: have, alreadyLocked: true };
            }

            const [holdings, minBalance, locked] = await Promise.all([
                this.rdBalanceEvents.getTotalCurrentHoldings(mbno, yearcode),
                this.rdRules.getRule('RULE_RD_MIN_BALANCE_AFTER_WITHDRAWAL'),
                this.getLockedAmount(mbno, queryRunner),
            ]);
            const lockable = Math.max(0, Math.round((holdings - locked - minBalance) * 100) / 100);
            if (amount > lockable) {
                throw new BadRequestException(
                    `Cannot lock ₹${amount.toLocaleString('en-IN')} of RD: the member has ₹${holdings.toLocaleString('en-IN')}, ` +
                    `₹${locked.toLocaleString('en-IN')} is already locked and ₹${minBalance.toLocaleString('en-IN')} must stay free. ` +
                    `At most ₹${lockable.toLocaleString('en-IN')} can be locked.`,
                );
            }

            const inserted = await queryRunner.query(
                `INSERT INTO rd_lien (mbno, loancaseno, lien_amount, rd_holdings_at_lien, placed_by)
                 VALUES ($1, $2, $3, $4, $5) RETURNING id`,
                [mbno, loanCaseNo, amount, holdings, (placedBy || '').slice(0, 50)],
            );

            if (ownsTransaction) await queryRunner.commitTransaction();
            return { id: inserted[0].id, lienAmount: amount, alreadyLocked: false };
        } catch (error) {
            if (ownsTransaction) await queryRunner.rollbackTransaction();
            throw error;
        } finally {
            if (ownsTransaction) await queryRunner.release();
        }
    }

    /**
     * Release the lien held for a loan case (loan closed). Returns the amount
     * released, or 0 when the case has no active lien — which is normal for any
     * loan that was never secured this way, so callers can invoke it on every
     * closure without checking the loan type first.
     */
    async release(
        loanCaseNo: string,
        releasedBy: string,
        reason: string,
        externalQueryRunner?: QueryRunner,
    ): Promise<number> {
        const rows = await (externalQueryRunner ?? this.dataSource).query(
            `UPDATE rd_lien
                SET status = 'RELEASED', released_at = now(), released_by = $2, release_reason = $3
              WHERE loancaseno = $1 AND status = 'ACTIVE'
          RETURNING lien_amount`,
            [loanCaseNo, (releasedBy || '').slice(0, 50), (reason || '').slice(0, 100)],
        );
        // TypeORM returns [rows, rowCount] for UPDATE ... RETURNING on postgres
        const returned = Array.isArray(rows[0]) ? rows[0] : rows;
        return returned.reduce((sum: number, r: any) => sum + Number(r.lien_amount || 0), 0);
    }

    /**
     * Loan re-agreement: the old case is closed and a new case carries the same
     * loan on, so the lock moves with it. Does nothing (returns false) when the
     * old case holds no lock — a legacy loan against RD that was never secured is
     * not newly locked just because it is restructured. Runs inside the caller's
     * transaction.
     */
    async transfer(
        params: { mbno: string; oldCaseNo: string; newCaseNo: string; amount: number; by: string },
        queryRunner: QueryRunner,
    ): Promise<boolean> {
        const active = await queryRunner.query(
            `SELECT 1 FROM rd_lien WHERE loancaseno = $1 AND status = 'ACTIVE'`, [params.oldCaseNo],
        );
        if (active.length === 0) return false;
        await this.release(params.oldCaseNo, params.by, `RE-AGREED INTO ${params.newCaseNo}`, queryRunner);
        await this.place(
            { mbno: params.mbno, loanCaseNo: params.newCaseNo, amount: params.amount, placedBy: params.by },
            queryRunner,
        );
        return true;
    }

    /** Undo of transfer() when a re-agreement is reversed: the new case's lock is
     *  released and the old case's own lock is made active again (same row, so
     *  its history stays in one place). A no-op when nothing was transferred. */
    async reinstate(
        params: { oldCaseNo: string; newCaseNo: string; by: string },
        queryRunner: QueryRunner,
    ): Promise<void> {
        const transferredReason = `RE-AGREED INTO ${params.newCaseNo}`;
        const was = await queryRunner.query(
            `SELECT id FROM rd_lien WHERE loancaseno = $1 AND status = 'RELEASED' AND release_reason = $2 ORDER BY id DESC LIMIT 1`,
            [params.oldCaseNo, transferredReason],
        );
        if (was.length === 0) return;
        await this.release(params.newCaseNo, params.by, 'RE-AGREEMENT REVERSED', queryRunner);
        await queryRunner.query(
            `UPDATE rd_lien SET status = 'ACTIVE', released_at = NULL, released_by = NULL, release_reason = NULL WHERE id = $1`,
            [was[0].id],
        );
    }

    private async getCurrentYearcode(queryRunner: QueryRunner): Promise<number | null> {
        const rows = await queryRunner.query(
            `SELECT yearcode FROM yearend WHERE start_date <= NOW() AND end_date >= NOW() LIMIT 1`,
        );
        return rows[0] ? Number(rows[0].yearcode) : null;
    }
}
