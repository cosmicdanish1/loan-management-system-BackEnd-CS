import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { FdAccount } from '../entities/fd-account.entity';
import { UpdateFdAccountDto } from '../dto/fd-account.dto';

@Injectable()
export class FdAccountService {
    constructor(
        @InjectRepository(FdAccount)
        private fdAccountRepository: Repository<FdAccount>,
    ) { }

    async findOne(accountNumber: number): Promise<FdAccount> {
        const fdAccount = await this.fdAccountRepository.findOne({ where: { accountNumber } });
        if (!fdAccount) {
            throw new NotFoundException(`FD Account ${accountNumber} not found`);
        }
        return fdAccount;
    }

    async update(accountNumber: number, updateDto: UpdateFdAccountDto): Promise<FdAccount> {
        const fdAccount = await this.findOne(accountNumber);
        Object.assign(fdAccount, updateDto);
        return this.fdAccountRepository.save(fdAccount);
    }
}
