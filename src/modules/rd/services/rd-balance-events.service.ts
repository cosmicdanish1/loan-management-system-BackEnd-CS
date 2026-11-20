import { Injectable, Optional, BadRequestException, NotFoundException } from '@nestjs/common';
import { DataSource, QueryRunner } from 'typeorm';
import { RdRulesService } from '../rd-rules.service';
import { toDateOnlyString } from '../rd-date-math';
import { SequenceGeneratorService } from '../../shared/services';
import { postRdCdPayment } from '../rd-cd-receipt';

export type RdBalanceEventType =
    | 'OPENING'
    | 'WITHDRAWAL'
    | 'LOAN_ADDITION'
    | 'INSTALLMENT_INTEREST_CREDIT'
    | 'OPENING_INTEREST_CREDIT';

export interface RdBalanceEventRow {
    id: number;
    eventDate: string;
    eventType: RdBalanceEventType;
    amount: number;
    resultingBalance: number;
    narration: string | null;
}

export interface RdWithdrawalResult {
    fromOpeningPot: number;
    fromInstallments: number;
    newOpeningPotBalance: number;
    remainingTotalHoldings: number;
}

/**
 * The RD balance-change timeline — every event that changes what balance is
 * earning opening-balance interest for a member+financial-year. Each row
 * carries its own resultingBalance (denormalized at write time under a
 * transaction lock, not recomputed from scratch on every read), so "current
 * balance" is always just the latest row, and the opening-balance interest
 * calculator (a later step) can walk these in date order for its
 * period-by-period calculation.
 */
@Injectable()
export class RdBalanceEventsService {
    constructor(
        private readonly dataSource: DataSource,
        private readonly rdRules: RdRulesService,
        @Optional() private readonly sequenceGenerator?: SequenceGeneratorService,
    ) { }

    /** The opening-balance POT alone (opening figure + withdrawals + loan
     *  additions + credited interest) — deliberately excludes this year's
     *  monthly installment payments, which live in a completely separate
     *  ledger (rd_installment_ledger) for interest-calculation reasons (see
     *  rd-opening-balance-interest.ts's docstring). Used internally by
     *  appendEvent() to compute a new event's delta, and by the withdrawal
     *  flow — a withdrawal today can only be recorded against this pot,
     *  not against money paid in via installments this year (a known,
     *  narrower scope than getTotalCurrentHoldings() below; widening it
     *  would require deciding how a withdrawal against installment money
     *  should be reflected in rd_installment_ledger, which doesn't have a
     *  natural column for it — left as a separate decision, not made here). */
    async getCurrentBalance(mbno: string, yearcode: number): Promise<number> {
        const rows = await this.dataSource.query(
            `SELECT resulting_balance FROM rd_balance_events
             WHERE mbno = $1 AND yearcode = $2
             ORDER BY event_date DESC, id DESC LIMIT 1`,
            [mbno, yearcode],
        );
        return rows[0] ? Number(rows[0].resulting_balance) : 0;
    }

    /** The member's TRUE total current RD holdings — the opening-balance
     *  pot PLUS whatever they've actually paid in via monthly installments
     *  this year (rd_installment_ledger) MINUS whatever has since been
     *  withdrawn from those specific installments, computed fresh on every
     *  call and never written back into any stored column. This is what
     *  loan eligibility must read: without it, a member who has been
     *  faithfully paying their RD all year would show a ₹0 balance for
     *  eligibility purposes until their year closes, defeating the whole
     *  point of the 5% RD requirement for the (very common) mid-year case.
     *  Mirrors the same combination financial-year closing uses for its own
     *  closing_balance, so both views of "how much RD does this member
     *  really have" agree with each other. */
    async getTotalCurrentHoldings(mbno: string, _yearcode?: number, queryRunner?: QueryRunner): Promise<number> {
        // RD and CD are ONE deposit (the society books both to head L1004; the legacy system never had a separate RD).
        // The single figure is member_balances.compulsory_deposit, so every screen, report, eligibility check and
        // withdrawal limit sees the same number. rd_balance_events / rd_installment_ledger stay as the INTEREST
        // timeline only and no longer decide how much RD a member holds. A negative CD (Group Insurance may leave it
        // below zero) is cleared separately out of the next loan payout, so it counts as 0 holdings here.
        const rows = await (queryRunner ?? this.dataSource).query(
            `SELECT COALESCE(SUM(compulsory_deposit), 0)::float AS total FROM member_balances WHERE mbno::numeric = $1::numeric`,
            [mbno],
        );
        return Math.round(Math.max(0, Number(rows[0]?.total || 0)) * 100) / 100;
    }

    async getTimeline(mbno: string, yearcode: number): Promise<RdBalanceEventRow[]> {
        const rows = await this.dataSource.query(
            `SELECT id, event_date, event_type, amount, resulting_balance, narration
             FROM rd_balance_events WHERE mbno = $1 AND yearcode = $2
             ORDER BY event_date ASC, id ASC`,
            [mbno, yearcode],
        );
        return rows.map((r: any) => ({
            id: r.id,
            eventDate: r.event_date,
            eventType: r.event_type,
            amount: Number(r.amount),
            resultingBalance: Number(r.resulting_balance),
            narration: r.narration,
        }));
    }

    /** Internal: appends one event under a row lock so two concurrent writes
     *  for the same member+year can never both read the same starting
     *  balance and silently clobber each other.
     *
     *  When the caller passes its own `externalQueryRunner` (already inside
     *  an open transaction — e.g. loan disbursement in
     *  pass-transaction.service.ts), this participates in THAT transaction
     *  instead of opening/committing its own: the advisory lock is
     *  xact-scoped, so it's held for exactly as long as the caller's
     *  transaction, and if the caller later rolls back, this insert rolls
     *  back with it — a loan-linked RD addition must never survive a
     *  disbursement that itself failed. Only when no external runner is
     *  given (the standalone withdrawal/interest-credit paths) does this
     *  method manage its own connect/commit/rollback/release. */
    private async appendEvent(
        mbno: string,
        yearcode: number,
        eventType: RdBalanceEventType,
        signedDelta: number,
        eventDate: Date,
        narration: string,
        createdBy: string,
        externalQueryRunner?: QueryRunner,
    ): Promise<number> {
        const queryRunner = externalQueryRunner ?? this.dataSource.createQueryRunner();
        const ownsTransaction = !externalQueryRunner;
        if (ownsTransaction) {
            await queryRunner.connect();
            await queryRunner.startTransaction();
        }
        try {
            // Advisory lock keyed on mbno+yearcode — same pattern already
            // used throughout this codebase for concurrency-sensitive
            // per-member sequences (loan/voucher id generation etc.).
            await queryRunner.query(
                `SELECT pg_advisory_xact_lock(hashtext('rd_balance_' || $1 || '_' || $2))`,
                [mbno, String(yearcode)],
            );
            const rows = await queryRunner.query(
                `SELECT resulting_balance FROM rd_balance_events
                 WHERE mbno = $1 AND yearcode = $2
                 ORDER BY event_date DESC, id DESC LIMIT 1`,
                [mbno, yearcode],
            );
            const currentBalance = rows[0] ? Number(rows[0].resulting_balance) : 0;
            const newBalance = Math.round((currentBalance + signedDelta) * 100) / 100;

            await queryRunner.query(
                `INSERT INTO rd_balance_events
                    (mbno, yearcode, event_date, event_type, amount, resulting_balance, narration, created_by)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
                // event_date is a DATE column — pass a plain 'YYYY-MM-DD'
                // string (built from eventDate's LOCAL components), never
                // the raw Date object itself. See toDateOnlyString()'s
                // docstring for the exact silent day-loss this avoids.
                [mbno, yearcode, toDateOnlyString(eventDate), eventType, Math.abs(signedDelta), newBalance, narration, createdBy],
            );
            if (ownsTransaction) await queryRunner.commitTransaction();
            return newBalance;
        } catch (error) {
            if (ownsTransaction) await queryRunner.rollbackTransaction();
            throw error;
        } finally {
            if (ownsTransaction) await queryRunner.release();
        }
    }

    /** Records the opening balance for a financial year — should only ever
     *  be called once per member+year (at FY start or rollover from the
     *  previous year's closing). Not idempotent-guarded here since that
     *  orchestration belongs to the FY-closing/rollover step, not this
     *  low-level ledger writer. */
    async recordOpeningBalance(
        mbno: string,
        yearcode: number,
        amount: number,
        asOfDate: Date,
        createdBy: string,
        externalQueryRunner?: QueryRunner,
    ): Promise<number> {
        // ES-353: an opening balance is money the member holds, so it must be a real number above zero
        if (!Number.isFinite(amount) || amount <= 0) {
            throw new BadRequestException('Opening balance must be a number greater than zero.');
        }
        return this.appendEvent(mbno, yearcode, 'OPENING', amount, asOfDate, 'Opening balance', createdBy, externalQueryRunner);
    }

    /** Withdraws against the member's TRUE total holdings (opening-balance
     *  pot + still-available installment money), draining the opening pot
     *  first and then, for whatever remains, the oldest still-available
     *  installments (FIFO by due date) via their own withdrawn_amount —
     *  never by reducing paid_amount, which would corrupt that
     *  installment's own pattern-eligibility/interest history.
     *
     *  The two pots are drained through two different mechanisms
     *  deliberately: an opening-pot withdrawal is a rd_balance_events row
     *  (so the opening-balance interest calculator sees it immediately, per
     *  its own "WITHDRAWAL = immediate effect" rule), while an
     *  installment-pot withdrawal is NOT — it must never appear in
     *  rd_balance_events, because that calculator would then wrongly charge
     *  negative opening-balance interest against money that was never part
     *  of the opening-balance pot to begin with. Both happen inside one
     *  transaction, under the same advisory lock appendEvent() itself uses,
     *  so a concurrent withdrawal can never double-spend either pot.
     *
     *  Accepts an optional externalQueryRunner (already inside an open
     *  transaction — e.g. loan early closure applying RD toward the closure
     *  amount) so this participates in THAT transaction instead of managing
     *  its own: if the caller's transaction later rolls back, this
     *  withdrawal rolls back with it, same as appendEvent's own handling. */
    async recordWithdrawal(
        mbno: string,
        yearcode: number,
        amount: number,
        asOfDate: Date,
        createdBy: string,
        narration?: string,
        externalQueryRunner?: QueryRunner,
    ): Promise<RdWithdrawalResult> {
        // ES-353: NaN is not <= 0, so it used to slip through every later comparison
        if (!Number.isFinite(amount) || amount <= 0) throw new BadRequestException('Withdrawal amount must be a number greater than zero.');

        const closedRows = await (externalQueryRunner ?? this.dataSource).query(
            `SELECT closed_at FROM rd_financial_year_summary WHERE mbno = $1 AND yearcode = $2`,
            [mbno, yearcode],
        );
        if (closedRows[0]?.closed_at) {
            throw new BadRequestException(`RD financial year ${yearcode} is already closed for member ${mbno} — cannot record a withdrawal against it.`);
        }

        const member = await (externalQueryRunner ?? this.dataSource).query(
            `SELECT mbno FROM member_master WHERE CAST(mbno AS text) = $1`,
            [mbno],
        );
        if (member.length === 0) throw new NotFoundException(`Member ${mbno} not found`);

        const totalHoldings = await this.getTotalCurrentHoldings(mbno, yearcode);
        const minBalance = await this.rdRules.getRule('RULE_RD_MIN_BALANCE_AFTER_WITHDRAWAL');
        // RD locked as security for a Loan Against RD can't be taken out, and the
        // minimum balance applies to what is left over once it is set aside.
        // Read through the caller's own transaction when there is one, so a lock
        // released earlier in that same transaction (the loan being closed) counts.
        const locked = await this.getLockedAmount(mbno, externalQueryRunner);
        const holdingsAfter = totalHoldings - amount;
        if (holdingsAfter < minBalance + locked) {
            const maxNow = Math.max(0, totalHoldings - locked - minBalance);
            throw new BadRequestException(
                locked > 0
                    ? `₹${locked.toLocaleString('en-IN')} of this member's RD is locked as security for a Loan Against RD ` +
                      `and cannot be withdrawn. Withdrawal would leave ₹${(holdingsAfter - locked).toLocaleString('en-IN')} ` +
                      `of free RD, below the required minimum of ₹${minBalance.toLocaleString('en-IN')}. ` +
                      `Maximum withdrawable right now: ₹${maxNow.toLocaleString('en-IN')}.`
                    : `Withdrawal would leave ₹${holdingsAfter.toLocaleString('en-IN')}, below the required minimum of ` +
                      `₹${minBalance.toLocaleString('en-IN')}. Maximum withdrawable right now: ` +
                      `₹${maxNow.toLocaleString('en-IN')}.`,
            );
        }

        const queryRunner = externalQueryRunner ?? this.dataSource.createQueryRunner();
        const ownsTransaction = !externalQueryRunner;
        if (ownsTransaction) {
            await queryRunner.connect();
            await queryRunner.startTransaction();
        }
        try {
            await queryRunner.query(
                `SELECT pg_advisory_xact_lock(hashtext('rd_balance_' || $1 || '_' || $2))`,
                [mbno, String(yearcode)],
            );

            // Re-check the lock now that this member's RD is serialised: a lock
            // placed between the check above and this point (a loan being
            // disbursed at the same moment) is now visible, and the withdrawal
            // must not slip past it.
            const lockedNow = await this.getLockedAmount(mbno, queryRunner);
            if (lockedNow > locked) {
                const holdingsNow = await this.getTotalCurrentHoldings(mbno, yearcode);
                if (holdingsNow - amount < minBalance + lockedNow) {
                    throw new BadRequestException(
                        `₹${lockedNow.toLocaleString('en-IN')} of this member's RD was just locked as security for a Loan Against RD, ` +
                        `so this withdrawal can no longer be made. Maximum withdrawable now: ` +
                        `₹${Math.max(0, holdingsNow - lockedNow - minBalance).toLocaleString('en-IN')}.`,
                    );
                }
            }

            const openingPotRows = await queryRunner.query(
                `SELECT resulting_balance FROM rd_balance_events
                 WHERE mbno = $1 AND yearcode = $2 ORDER BY event_date DESC, id DESC LIMIT 1`,
                [mbno, yearcode],
            );
            const openingPot = openingPotRows[0] ? Number(openingPotRows[0].resulting_balance) : 0;

            let remaining = amount;
            let fromOpeningPot = 0;
            let newOpeningPotBalance = openingPot;
            if (openingPot > 0 && remaining > 0) {
                fromOpeningPot = Math.min(openingPot, remaining);
                newOpeningPotBalance = await this.appendEvent(
                    mbno, yearcode, 'WITHDRAWAL', -fromOpeningPot, asOfDate,
                    narration || 'Withdrawal', createdBy, queryRunner,
                );
                remaining = Math.round((remaining - fromOpeningPot) * 100) / 100;
            }

            let fromInstallments = 0;
            if (remaining > 0) {
                const installmentRows = await queryRunner.query(
                    `SELECT id, paid_amount, withdrawn_amount FROM rd_installment_ledger
                     WHERE mbno = $1 AND yearcode = $2 AND (paid_amount - withdrawn_amount) > 0
                     ORDER BY due_date ASC FOR UPDATE`,
                    [mbno, yearcode],
                );
                for (const row of installmentRows) {
                    if (remaining <= 0) break;
                    const available = Number(row.paid_amount) - Number(row.withdrawn_amount);
                    const take = Math.min(available, remaining);
                    await queryRunner.query(
                        `UPDATE rd_installment_ledger SET withdrawn_amount = withdrawn_amount + $1,
                            narration = LEFT(COALESCE(narration, '') || $2, 255)
                         WHERE id = $3`,
                        [take, ` | Withdrawn ₹${take.toLocaleString('en-IN')} on ${toDateOnlyString(asOfDate)} (by ${createdBy})`, row.id],
                    );
                    fromInstallments = Math.round((fromInstallments + take) * 100) / 100;
                    remaining = Math.round((remaining - take) * 100) / 100;
                }
                // Whatever the interest timeline (opening pot + installments) does not cover is plain CD balance
                // (every migrated member, for example, has no timeline at all): it is taken from the one RD/CD figure below.
            }

            // The single RD/CD balance goes down by the whole amount, under the lock, and never below zero:
            // a concurrent withdrawal that already used the money makes this update find no row and the whole
            // withdrawal fails instead of overdrawing.
            // ES-579: the minimum balance and the Loan Against RD lock are enforced in this same statement, not only in the
            // check at the top (that one ran before the lock, so two withdrawals at the same moment could both pass it
            // and together leave less than the minimum).
            const cdUpdate = await queryRunner.query(
                `UPDATE member_balances SET compulsory_deposit = compulsory_deposit - $1
                  WHERE mbno::numeric = $2::numeric AND compulsory_deposit >= $1 AND compulsory_deposit - $1 >= $3
                  RETURNING compulsory_deposit`,
                [amount, mbno, minBalance + lockedNow],
            );
            if (!cdUpdate[0] || cdUpdate[0].length === 0) {
                throw new BadRequestException(
                    `The member's RD/CD balance changed, so ₹${amount.toLocaleString('en-IN')} can no longer be withdrawn ` +
                    `(the minimum balance of ₹${minBalance.toLocaleString('en-IN')} and any Loan Against RD lock must stay). Please check the balance and retry.`,
                );
            }

            if (ownsTransaction) await queryRunner.commitTransaction();
            const remainingTotalHoldings = Math.round((totalHoldings - amount) * 100) / 100;
            return { fromOpeningPot, fromInstallments, newOpeningPotBalance, remainingTotalHoldings };
        } catch (error) {
            if (ownsTransaction) await queryRunner.rollbackTransaction();
            throw error;
        } finally {
            if (ownsTransaction) await queryRunner.release();
        }
    }

    /**
     * ES-579: the RD/CD Withdrawal window. Takes the money out of the member's RD/CD balance (recordWithdrawal) AND books
     * the cash paid out: a CD payment voucher, DR RD/CD (L1004) + CR cash (A1001) in the ledger, the transaction rows and
     * a cash-book payment line, all in one transaction. (recordWithdrawal alone is also used by loan early closure,
     * which posts its own ledger entries, so the posting is NOT inside recordWithdrawal.)
     */
    async withdrawAndPost(
        mbno: string,
        yearcode: number,
        amount: number,
        asOfDate: Date,
        username: string,
        narration?: string,
    ): Promise<RdWithdrawalResult & { voucherNo: string; newBalance: number }> {
        if (!this.sequenceGenerator) throw new Error('Voucher numbering is not available.');
        if (!Number.isFinite(amount) || amount <= 0) throw new BadRequestException('Withdrawal amount must be a number greater than zero.');
        if (amount > 9_999_999.99) throw new BadRequestException('Withdrawal amount is too large.');
        if (!(asOfDate instanceof Date) || Number.isNaN(asOfDate.getTime())) throw new BadRequestException('The withdrawal date is not a valid date.');
        const endOfToday = new Date(); endOfToday.setHours(23, 59, 59, 999);
        if (asOfDate.getTime() > endOfToday.getTime()) throw new BadRequestException('The withdrawal date cannot be in the future.');
        const dateStr = toDateOnlyString(asOfDate);

        const voucherNo = await this.sequenceGenerator.getNextVoucherNumber();
        const qr = this.dataSource.createQueryRunner();
        await qr.connect();
        await qr.startTransaction();
        try {
            const result = await this.recordWithdrawal(mbno, yearcode, amount, asOfDate, username, narration, qr);
            const balRows = await qr.query(`SELECT COALESCE(compulsory_deposit, 0)::float AS bal FROM member_balances WHERE mbno::numeric = $1::numeric`, [mbno]);
            const newBalance = Math.round(Number(balRows[0]?.bal || 0) * 100) / 100;
            await postRdCdPayment(qr, {
                mbno, amount, date: dateStr, voucherNo, newBalance,
                text: 'RD/CD withdrawal',
                description: `RD/CD withdrawal${narration && narration !== 'Withdrawal' ? ' - ' + narration : ''}`,
                remarks: 'RD_CD_WITHDRAWAL', username,
            });
            await qr.commitTransaction();
            return { ...result, voucherNo, newBalance };
        } catch (error) {
            await qr.rollbackTransaction();
            throw error;
        } finally {
            await qr.release();
        }
    }

    /** Called by the loan-eligibility integration (a later step) when a
     *  loan's RD shortfall is withheld from disbursement and credited here
     *  instead. Per the user's spec, this addition earns opening-balance
     *  interest only from the FOLLOWING month, not the month it's added in
     *  — the opening-balance interest calculator (a later step) enforces
     *  that by reading this event's own eventDate, not by anything recorded
     *  here. */
    async recordLoanAddition(
        mbno: string,
        yearcode: number,
        amount: number,
        asOfDate: Date,
        narration: string,
        createdBy: string,
        externalQueryRunner?: QueryRunner,
    ): Promise<number> {
        if (amount <= 0) throw new BadRequestException('Loan-linked RD addition must be greater than zero.');
        return this.appendEvent(mbno, yearcode, 'LOAN_ADDITION', amount, asOfDate, narration, createdBy, externalQueryRunner);
    }

    /** Called only by the financial-year closing step (interest is credited
     *  once, at year-end). */
    async recordInterestCredit(
        mbno: string,
        yearcode: number,
        amount: number,
        eventType: 'INSTALLMENT_INTEREST_CREDIT' | 'OPENING_INTEREST_CREDIT',
        asOfDate: Date,
        createdBy: string,
        externalQueryRunner?: QueryRunner,
    ): Promise<number> {
        if (amount <= 0) return this.getCurrentBalance(mbno, yearcode);
        return this.appendEvent(mbno, yearcode, eventType, amount, asOfDate,
            eventType === 'INSTALLMENT_INTEREST_CREDIT' ? 'RD installment interest credited' : 'Opening-balance interest credited',
            createdBy, externalQueryRunner);
    }

    /** How much a member could withdraw right now without breaching the
     *  configured minimum — used by the withdrawal screen to show a live
     *  cap before the operator even types an amount. Based on TRUE total
     *  holdings (opening pot + still-available installment money), matching
     *  what recordWithdrawal() actually allows. */
    async getMaxWithdrawable(mbno: string, yearcode: number): Promise<number> {
        const totalHoldings = await this.getTotalCurrentHoldings(mbno, yearcode);
        const minBalance = await this.rdRules.getRule('RULE_RD_MIN_BALANCE_AFTER_WITHDRAWAL');
        const locked = await this.getLockedAmount(mbno);
        return Math.max(0, Math.round((totalHoldings - locked - minBalance) * 100) / 100);
    }

    /** RD currently locked for this member as security for Loan Against RD
     *  loans (rd_lien, ACTIVE rows). Pass the caller's open transaction to see
     *  locks it has placed or released but not yet committed. */
    async getLockedAmount(mbno: string, queryRunner?: QueryRunner): Promise<number> {
        const rows = await (queryRunner ?? this.dataSource).query(
            `SELECT COALESCE(SUM(lien_amount), 0) AS total FROM rd_lien WHERE mbno = $1 AND status = 'ACTIVE'`,
            [mbno],
        );
        return Number(rows[0]?.total || 0);
    }
}
