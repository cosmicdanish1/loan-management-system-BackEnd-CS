import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { SbAccount } from '../entities/sb-account.entity';
import { CreateSbAccountDto, UpdateSbAccountDto } from '../dto/sb-account.dto';

@Injectable()
export class SbAccountService {
    constructor(
        @InjectRepository(SbAccount)
        private readonly sbAccountRepository: Repository<SbAccount>,
    ) { }

    async create(createDto: CreateSbAccountDto): Promise<SbAccount> {
        const sbAccount = this.sbAccountRepository.create({
            ...createDto,
            openingDate: createDto.openingDate ? new Date(createDto.openingDate) : new Date(),
            currentBalance: createDto.openingBalance
        });
        return await this.sbAccountRepository.save(sbAccount);
    }

    async findAll(): Promise<SbAccount[]> {
        return await this.sbAccountRepository.find();
    }

    async findOne(id: string): Promise<SbAccount> {
        const sbAccount = await this.sbAccountRepository.findOne({ where: { accountNo: id } });
        if (!sbAccount) {
            throw new NotFoundException(`SB Account with ID ${id} not found`);
        }
        return sbAccount;
    }

    async update(id: string, updateDto: UpdateSbAccountDto): Promise<SbAccount> {
        const sbAccount = await this.findOne(id);
        this.sbAccountRepository.merge(sbAccount, {
            ...updateDto,
            openingDate: updateDto.openingDate ? new Date(updateDto.openingDate) : sbAccount.openingDate
        });
        return await this.sbAccountRepository.save(sbAccount);
    }

    async remove(id: string): Promise<void> {
        const result = await this.sbAccountRepository.delete(id);
        if (result.affected === 0) {
            throw new NotFoundException(`SB Account with ID ${id} not found`);
        }
    }
}
