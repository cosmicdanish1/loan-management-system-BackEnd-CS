import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { FundsMaster } from '../entities/funds-master.entity';
import { UpdateMemberFundsDto } from '../dto/member-funds.dto';

@Injectable()
export class MemberFundsService {
    constructor(
        @InjectRepository(FundsMaster)
        private fundsRepository: Repository<FundsMaster>,
    ) { }

    async findByMember(memberNo: number): Promise<FundsMaster> {
        const funds = await this.fundsRepository.findOne({ where: { memberNo } });
        if (!funds) {
            // Return a default object if not found, to allow initial data entry
            return {
                memberNo,
                monthlyContributionInstallment: 0,
                compulsoryDepositInstallment: 0,
                sharesInstallment: 0,
                monthlyContributionOpeningBalance: 0,
                sharesOpeningBalance: 0,
                compulsoryDepositOpeningBalance: 0,
                suspenseBalance: 0,
                loanExecutionReceipt: 0
            };
        }
        return funds;
    }

    async updateBalances(memberNo: number, updateDto: UpdateMemberFundsDto): Promise<FundsMaster> {
        let funds = await this.fundsRepository.findOne({ where: { memberNo } });

        if (!funds) {
            funds = this.fundsRepository.create({
                memberNo,
                ...updateDto
            });
        } else {
            Object.assign(funds, updateDto);
        }

        return this.fundsRepository.save(funds);
    }
}
