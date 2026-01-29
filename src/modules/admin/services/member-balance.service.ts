import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { MemberBalance } from '../entities/member-balance.entity';
import { UpdateMemberBalanceDto } from '../dto/member-balance.dto';

@Injectable()
export class MemberBalanceService {
    constructor(
        @InjectRepository(MemberBalance)
        private memberBalanceRepository: Repository<MemberBalance>,
    ) { }

    async findOne(memberNo: number): Promise<MemberBalance> {
        const balance = await this.memberBalanceRepository.findOne({ where: { memberNo } });
        if (!balance) {
            throw new NotFoundException(`Balance for Member No ${memberNo} not found`);
        }
        return balance;
    }

    async update(memberNo: number, updateDto: UpdateMemberBalanceDto): Promise<MemberBalance> {
        let balance = await this.memberBalanceRepository.findOne({ where: { memberNo } });

        if (!balance) {
            // Create if it doesn't exist (though usually it should exist for a member)
            balance = this.memberBalanceRepository.create({ memberNo });
        }

        Object.assign(balance, updateDto);
        return this.memberBalanceRepository.save(balance);
    }
}
