import { Injectable, Logger, BadRequestException, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { FundsMaster } from '../entities/funds-master.entity';
import { UpdateMemberFundsDto } from '../dto/member-funds.dto';
import { MemberValidationUtil } from '../../member/utils';

@Injectable()
export class MemberFundsService {
    private readonly logger = new Logger(MemberFundsService.name);

    constructor(
        @InjectRepository(FundsMaster)
        private fundsRepository: Repository<FundsMaster>,
    ) { }

    async getMemberList(wing?: string): Promise<string[]> {
        this.logger.log(`[MemberFunds] Loading ordered member list from fundsmaster${wing ? ` (wing=${wing})` : ''}`);
        if (wing) {
            // ES-491: Wing filter of Modify Member Balance — only members of that wing (member_master.wingno).
            const filtered = await this.fundsRepository.query(
                `SELECT f.mbno FROM fundsmaster f
                 JOIN member_master m ON m.mbno = f.mbno
                 WHERE m.wingno = $1
                 ORDER BY f.mbno ASC`,
                [String(wing)],
            );
            return filtered.map((r: any) => String(r.mbno));
        }
        const rows = await this.fundsRepository.find({
            select: ['memberNo'],
            order: { memberNo: 'ASC' }
        });
        return rows.map(r => r.memberNo.toString());
    }

    /** ES-491: wings that have members in fundsmaster, for the Wing filter (id = wing code, name = wing name). */
    async getWings(): Promise<{ id: string; name: string }[]> {
        const rows = await this.fundsRepository.query(
            `SELECT DISTINCT m.wingno AS id, COALESCE(NULLIF(w.wname, ''), m.wingno) AS name
             FROM member_master m
             JOIN fundsmaster f ON f.mbno = m.mbno
             LEFT JOIN wingmast w ON w.wingno = m.wingno
             WHERE m.wingno IS NOT NULL AND m.wingno <> ''
             ORDER BY name`,
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
        return { ...funds, ...(await this.latestLoanFigures(memberNo)) } as FundsMaster;
    }

    /**
     * Regular / Emergency loan boxes: the Op. Balance and Inst. Amount of the member's latest loan of each type
     * (RLN / ALN) in loan_master, as the legacy screen shows them. They are NOT fundsmaster columns: md1_* / md2_* hold
     * the member's FRS-2 / MD2 contribution, which an earlier version of this screen showed and saved as the loans.
     */
    private async latestLoanFigures(memberNo: number): Promise<Pick<FundsMaster, 'rlnOpBal' | 'rlnAmt' | 'elnOpBal' | 'elnAmt'>> {
        const rows = await this.fundsRepository.query(
            `SELECT DISTINCT ON (loantype) loantype, COALESCE(openbalance, 0)::float AS op, COALESCE(instal_amt, 0)::float AS inst
               FROM loan_master WHERE mbno = $1::numeric AND loantype IN ('RLN', 'ALN')
              ORDER BY loantype, payment_date DESC NULLS LAST, loancaseno DESC`,
            [memberNo],
        );
        const by = (t: string) => rows.find((r: any) => r.loantype === t);
        return { rlnOpBal: by('RLN')?.op ?? 0, rlnAmt: by('RLN')?.inst ?? 0, elnOpBal: by('ALN')?.op ?? 0, elnAmt: by('ALN')?.inst ?? 0 };
    }

    async updateBalances(memberNo: number, updateDto: UpdateMemberFundsDto): Promise<FundsMaster> {
        this.logger.log(`[MemberFunds] Updating fundsmaster for mbno=${memberNo}`);

        // Loan boxes are read-only here (they come from loan_master; see latestLoanFigures). Never write them to md1_* / md2_*.
        for (const k of ['rlnOpBal', 'rlnAmt', 'elnOpBal', 'elnAmt'] as const) delete (updateDto as any)[k];

        // FRS (MD) eligibility: members who joined at age 50+ are locked to
        // the ₹2 nominal contribution — block any manual edit here that
        // would raise it above that. Age is evaluated at the member's actual
        // membership date, not today, so this never restricts someone who
        // simply grew old as a member.
        if (updateDto.monthlyContributionInstallment !== undefined && updateDto.monthlyContributionInstallment !== 2) {
            const memberRows = await this.fundsRepository.manager.query(
                `SELECT dob, memb_date FROM member_master WHERE mbno = $1`,
                [memberNo],
            );
            const member = memberRows[0];
            if (member?.dob) {
                const membershipDate = member.memb_date ? new Date(member.memb_date) : new Date();
                const ageAtJoining = MemberValidationUtil.ageAtDate(new Date(member.dob), membershipDate);
                if (ageAtJoining >= 50) {
                    throw new BadRequestException(
                        `Member ${memberNo} joined at age ${ageAtJoining} and is not eligible for FRS — only the ₹2 nominal contribution is allowed`,
                    );
                }
            }
        }

        let funds = await this.fundsRepository.findOne({ where: { memberNo } });

        // Opening balances are history carried in from the legacy (the RD/CD year-end interest and the ledger opening are
        // worked out from them). They cannot be changed once the member has a funds row; a brand-new row may set them.
        if (funds) {
            const openingFields: Array<keyof UpdateMemberFundsDto> = [
                'sharesOpeningBalance', 'monthlyContributionOpeningBalance', 'compulsoryDepositOpeningBalance',
            ];
            const changed = openingFields.filter(
                (k) => updateDto[k] !== undefined && Math.abs(Number(updateDto[k]) - Number((funds as any)[k] ?? 0)) > 0.004,
            );
            if (changed.length > 0) {
                throw new BadRequestException(
                    `Opening balances cannot be changed here (${changed.join(', ')}). They are the balances carried in from the previous system.`,
                );
            }
            for (const k of openingFields) delete (updateDto as any)[k];
        }

        // The RD/CD monthly amount lives in RD/CD Member Setup too (it is what the RD/CD windows and the demand use), so a
        // changed CD installment is written there as well, effective from the 1st of this month, as a new history row.
        const newCdAmount = updateDto.compulsoryDepositInstallment;
        const cdChanged = newCdAmount !== undefined && Number(newCdAmount) > 0
            && Math.abs(Number(newCdAmount) - Number((funds as any)?.compulsoryDepositInstallment ?? 0)) > 0.004;

        if (!funds) {
            // A row may only be created for a real member (ES-300): otherwise any member number makes an orphan row
            const real = await this.fundsRepository.manager.query(`SELECT 1 FROM member_master WHERE mbno = $1`, [memberNo]);
            if (!real || real.length === 0) {
                throw new NotFoundException(`Member ${memberNo} does not exist`);
            }
            this.logger.log(`[MemberFunds] No existing record, creating new for mbno=${memberNo}`);
            funds = this.fundsRepository.create({ memberNo, ...updateDto });
        } else {
            Object.assign(funds, updateDto);
        }

        const saved = await this.fundsRepository.save(funds);
        this.logger.log(`[MemberFunds] Saved fundsmaster for mbno=${memberNo}`);

        if (cdChanged) {
            const manager = this.fundsRepository.manager;
            const yr = await manager.query(`SELECT yearcode FROM yearend WHERE start_date <= CURRENT_DATE AND end_date >= CURRENT_DATE LIMIT 1`);
            if (yr?.[0]?.yearcode != null) {
                const latest = await manager.query(
                    `SELECT monthly_rd_amount::float AS amount FROM rd_member_config WHERE mbno::numeric = $1::numeric AND yearcode = $2
                      ORDER BY effective_from_date DESC, id DESC LIMIT 1`,
                    [memberNo, yr[0].yearcode],
                );
                if (!(Math.abs(Number(latest?.[0]?.amount ?? -1) - Number(newCdAmount)) < 0.004)) {
                    await manager.query(
                        `INSERT INTO rd_member_config (mbno, yearcode, monthly_rd_amount, effective_from_date, set_by)
                         VALUES ($1, $2, $3, date_trunc('month', CURRENT_DATE)::date, 'MODIFY MEMBER BALANCE')`,
                        [String(memberNo), yr[0].yearcode, newCdAmount],
                    );
                }
            }
        }
        return saved;
    }
}
