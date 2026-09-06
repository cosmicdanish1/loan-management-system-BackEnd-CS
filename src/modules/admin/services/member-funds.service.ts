import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, QueryRunner, Repository } from 'typeorm';
import { FundsMaster } from '../entities/funds-master.entity';
import { UpdateMemberFundsDto } from '../dto/member-funds.dto';

@Injectable()
export class MemberFundsService {
    private readonly logger = new Logger(MemberFundsService.name);

    constructor(
        @InjectRepository(FundsMaster)
        private fundsRepository: Repository<FundsMaster>,
        private readonly dataSource: DataSource,
    ) { }

    async getMemberList(wing?: string): Promise<string[]> {
        // Optionally restrict to a wing. member wing lives in member_master.wingno, so join on mbno.
        if (wing && wing.trim()) {
            this.logger.log(`[MemberFunds] Loading member list for wing=${wing}`);
            const rows = await this.fundsRepository.query(
                `SELECT f.mbno FROM fundsmaster f
                 JOIN member_master m ON m.mbno = f.mbno
                 WHERE m.wingno = $1
                 ORDER BY f.mbno ASC`,
                [wing]
            );
            return rows.map((r: any) => String(r.mbno));
        }
        this.logger.log('[MemberFunds] Loading ordered member list from fundsmaster');
        const rows = await this.fundsRepository.find({
            select: ['memberNo'],
            order: { memberNo: 'ASC' }
        });
        return rows.map(r => r.memberNo.toString());
    }

    // Wings that actually have members in fundsmaster — so every dropdown option yields results.
    // Name comes from wing_master when available, else falls back to the code itself.
    async getWings(): Promise<{ id: string; name: string }[]> {
        const rows = await this.fundsRepository.query(
            `SELECT DISTINCT m.wingno AS id, COALESCE(NULLIF(w.wingname, ''), m.wingno) AS name
             FROM member_master m
             JOIN fundsmaster f ON f.mbno = m.mbno
             LEFT JOIN wing_master w ON w.wingno = m.wingno
             WHERE m.wingno IS NOT NULL AND m.wingno <> ''
             ORDER BY name`
        );
        return rows.map((r: any) => ({ id: String(r.id), name: String(r.name) }));
    }

    async findByMember(memberNo: number): Promise<FundsMaster> {
        if (!Number.isFinite(memberNo) || memberNo <= 0) {
            throw new Error(`Invalid member number: ${memberNo}`);
        }
        this.logger.log(`[MemberFunds] Looking up fundsmaster for mbno=${memberNo}`);
        const funds = await this.fundsRepository.findOne({ where: { memberNo } });
        if (!funds) {
            this.logger.warn(`[MemberFunds] No record found for mbno=${memberNo}, returning defaults`);
            return {
                memberNo,
                monthlyContributionInstallment: 0,
                compulsoryDepositInstallment: 0,
                sharesInstallment: 0,
                monthlyContributionOpeningBalance: 0,
                sharesOpeningBalance: 0,
                compulsoryDepositOpeningBalance: 0,
                suspenseBalance: 0,
                loanExecutionReceipt: 0,
                rlnOpBal: 0,
                rlnAmt: 0,
                elnOpBal: 0,
                elnAmt: 0,
            };
        }
        this.logger.log(`[MemberFunds] Found record for mbno=${memberNo}`);
        return funds;
    }

    // Idempotent audit table — records every balance edit (who / when / before / after).
    private async ensureAuditTable(runner: QueryRunner): Promise<void> {
        await runner.query(`
            CREATE TABLE IF NOT EXISTS member_funds_audit (
                id          SERIAL PRIMARY KEY,
                mbno        NUMERIC NOT NULL,
                changed_by  VARCHAR(100),
                changed_at  TIMESTAMP DEFAULT NOW(),
                old_values  JSONB,
                new_values  JSONB
            )
        `);
    }

    // Balance save, loan_master sync, and the audit row must all land together or not at all —
    // previously these were 4 independent queries, so a failure partway left fundsmaster updated
    // with loan_master/audit silently out of sync and no way to detect it.
    async updateBalances(memberNo: number, updateDto: UpdateMemberFundsDto, changedBy = 'system'): Promise<FundsMaster> {
        if (!Number.isFinite(memberNo) || memberNo <= 0) {
            throw new Error(`Invalid member number: ${memberNo}`);
        }

        this.logger.log(`[MemberFunds] Updating fundsmaster for mbno=${memberNo} by ${changedBy}`);

        const runner = this.dataSource.createQueryRunner();
        await runner.connect();
        await runner.startTransaction();
        try {
            const fundsRepo = runner.manager.getRepository(FundsMaster);
            let funds = await fundsRepo.findOne({ where: { memberNo } });

            // Snapshot the pre-change state for the audit trail (null = brand-new record).
            const oldValues = funds ? { ...funds } : null;

            if (!funds) {
                this.logger.log(`[MemberFunds] No existing record, creating new for mbno=${memberNo}`);
                funds = fundsRepo.create({ memberNo, ...updateDto });
            } else {
                Object.assign(funds, updateDto);
            }

            const saved = await fundsRepo.save(funds);

            // Sync loan_master if loan opening balances or installment amounts changed.
            // Legacy stores these in loan_master.openbalance / instal_amt, not fundsmaster.
            // Note: every real loan in this system is recorded with loantype='ALN' (see
            // loan-sanction.service.ts) — 'RLN' never appears in loan_master, so this branch
            // is currently a no-op by design of the existing data, kept for forward-compat.
            if (updateDto.rlnOpBal !== undefined || updateDto.rlnAmt !== undefined) {
                await runner.query(
                    `UPDATE loan_master SET
                        openbalance = COALESCE($2, openbalance),
                        instal_amt = COALESCE($3, instal_amt)
                     WHERE mbno = $1 AND loantype = 'RLN' AND balance > 0`,
                    [memberNo, updateDto.rlnOpBal ?? null, updateDto.rlnAmt ?? null]
                );
            }
            if (updateDto.elnOpBal !== undefined || updateDto.elnAmt !== undefined) {
                await runner.query(
                    `UPDATE loan_master SET
                        openbalance = COALESCE($2, openbalance),
                        instal_amt = COALESCE($3, instal_amt)
                     WHERE mbno = $1 AND loantype IN ('ALN','ELN') AND balance > 0`,
                    [memberNo, updateDto.elnOpBal ?? null, updateDto.elnAmt ?? null]
                );
            }

            await this.ensureAuditTable(runner);
            await runner.query(
                `INSERT INTO member_funds_audit (mbno, changed_by, old_values, new_values) VALUES ($1, $2, $3, $4)`,
                [memberNo, changedBy, oldValues ? JSON.stringify(oldValues) : null, JSON.stringify(saved)]
            );

            await runner.commitTransaction();
            this.logger.log(`[MemberFunds] Saved fundsmaster for mbno=${memberNo}`);
            return saved;
        } catch (err) {
            await runner.rollbackTransaction();
            this.logger.error(`[MemberFunds] Update failed for mbno=${memberNo}, rolled back:`, err as any);
            throw err;
        } finally {
            await runner.release();
        }
    }
}
