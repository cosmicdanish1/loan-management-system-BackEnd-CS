import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { RdAccount } from '../entities/rd-account.entity';
import { CreateRdAccountDto, UpdateRdAccountDto } from '../dto/rd-account.dto';

@Injectable()
export class RdAccountService {
    constructor(
        @InjectRepository(RdAccount)
        private readonly rdAccountRepository: Repository<RdAccount>,
    ) { }

    async create(createDto: CreateRdAccountDto): Promise<RdAccount> {
        const rdAccount = this.rdAccountRepository.create({
            ...createDto
        });
        return await this.rdAccountRepository.save(rdAccount);
    }

    async findAll(): Promise<RdAccount[]> {
        return await this.rdAccountRepository.find();
    }

    async findOne(id: number): Promise<RdAccount> {
        const rdAccount = await this.rdAccountRepository.findOne({ where: { accountNumber: id } });
        if (!rdAccount) {
            throw new NotFoundException(`RD Account with ID ${id} not found`);
        }
        return rdAccount;
    }

    async update(id: number, updateDto: UpdateRdAccountDto): Promise<RdAccount> {
        const rdAccount = await this.findOne(id);
        this.rdAccountRepository.merge(rdAccount, { ...updateDto });
        return await this.rdAccountRepository.save(rdAccount);
    }

    async remove(id: number): Promise<void> {
        const result = await this.rdAccountRepository.delete(id);
        if (result.affected === 0) {
            throw new NotFoundException(`RD Account with ID ${id} not found`);
        }
    }
}
