import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { BankMember } from '../entities/member.entity';

@Injectable()
export class MemberAdminService {
    constructor(
        @InjectRepository(BankMember)
        private readonly memberRepository: Repository<BankMember>,
    ) { }

    async findOne(memberNo: number): Promise<BankMember> {
        const member = await this.memberRepository.findOne({ where: { memberNo } });
        if (!member) {
            throw new NotFoundException(`Member with ID ${memberNo} not found`);
        }
        return member;
    }

    async updateOffice(memberNo: number, newOfficeId: string): Promise<BankMember> {
        const member = await this.findOne(memberNo);
        member.officeId = newOfficeId;
        return this.memberRepository.save(member);
    }
}
