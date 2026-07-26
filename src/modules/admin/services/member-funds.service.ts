import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { FundsMaster } from '../entities/funds-master.entity';
import { UpdateMemberFundsDto } from '../dto/member-funds.dto';

@Injectable()
export class MemberFundsService {
    private readonly logger = new Logger(MemberFundsService.name);

    constructor(
        @InjectRepository(FundsMaster)
        private fundsRepository: Repository<FundsMaster>,
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
    private async ensureAuditTable(): Promise<void> {
        await this.fundsRepository.query(`
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

    async updateBalances(memberNo: number, updateDto: UpdateMemberFundsDto, changedBy = 'system'): Promise<FundsMaster> {
        this.logger.log(`[MemberFunds] Updating fundsmaster for mbno=${memberNo} by ${changedBy}`);
        let funds = await this.fundsRepository.findOne({ where: { memberNo } });

        // Snapshot the pre-change state for the audit trail (null = brand-new record).
        const oldValues = funds ? { ...funds } : null;

        if (!funds) {
            this.logger.log(`[MemberFunds] No existing record, creating new for mbno=${memberNo}`);
            funds = this.fundsRepository.create({ memberNo, ...updateDto });
        } else {
            Object.assign(funds, updateDto);
        }

        const saved = await this.fundsRepository.save(funds);

        // Sync loan_master if loan opening balances or installment amounts changed
        // Legacy stores these in loan_master.openbalance / instal_amt, not fundsmaster
        if (updateDto.rlnOpBal !== undefined || updateDto.rlnAmt !== undefined) {
            await this.fundsRepository.query(
                `UPDATE loan_master SET
                    openbalance = COALESCE($2, openbalance),
                    instal_amt = COALESCE($3, instal_amt)
                 WHERE mbno = $1 AND loantype = 'RLN' AND balance > 0`,
                [memberNo, updateDto.rlnOpBal ?? null, updateDto.rlnAmt ?? null]
            );
        }
        if (updateDto.elnOpBal !== undefined || updateDto.elnAmt !== undefined) {
            await this.fundsRepository.query(
                `UPDATE loan_master SET
                    openbalance = COALESCE($2, openbalance),
                    instal_amt = COALESCE($3, instal_amt)
                 WHERE mbno = $1 AND loantype IN ('ALN','ELN') AND balance > 0`,
                [memberNo, updateDto.elnOpBal ?? null, updateDto.elnAmt ?? null]
            );
        }

        // Write the audit row. Never let an audit failure roll back a successful balance save.
        try {
            await this.ensureAuditTable();
            await this.fundsRepository.query(
                `INSERT INTO member_funds_audit (mbno, changed_by, old_values, new_values) VALUES ($1, $2, $3, $4)`,
                [memberNo, changedBy, oldValues ? JSON.stringify(oldValues) : null, JSON.stringify(saved)]
            );
        } catch (auditErr) {
            this.logger.error(`[MemberFunds] Audit write failed for mbno=${memberNo}:`, auditErr as any);
        }

        this.logger.log(`[MemberFunds] Saved fundsmaster for mbno=${memberNo}`);
        return saved;
    }
}
