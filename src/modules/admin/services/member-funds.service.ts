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

    async getMemberList(): Promise<string[]> {
        this.logger.log('[MemberFunds] Loading ordered member list from fundsmaster');
        const rows = await this.fundsRepository.find({
            select: ['memberNo'],
            order: { memberNo: 'ASC' }
        });
        return rows.map(r => r.memberNo.toString());
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

    async updateBalances(memberNo: number, updateDto: UpdateMemberFundsDto): Promise<FundsMaster> {
        this.logger.log(`[MemberFunds] Updating fundsmaster for mbno=${memberNo}`);
        let funds = await this.fundsRepository.findOne({ where: { memberNo } });

        if (!funds) {
            this.logger.log(`[MemberFunds] No existing record, creating new for mbno=${memberNo}`);
            funds = this.fundsRepository.create({ memberNo, ...updateDto });
        } else {
            Object.assign(funds, updateDto);
        }

        const saved = await this.fundsRepository.save(funds);
        this.logger.log(`[MemberFunds] Saved fundsmaster for mbno=${memberNo}`);
        return saved;
    }
}
