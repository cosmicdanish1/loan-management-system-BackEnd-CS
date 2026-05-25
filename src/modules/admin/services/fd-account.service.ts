import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { FdAccount } from '../entities/fd-account.entity';
import { UpdateFdAccountDto } from '../dto/fd-account.dto';

@Injectable()
export class FdAccountService {
    private readonly logger = new Logger(FdAccountService.name);

    constructor(
        @InjectRepository(FdAccount)
        private fdAccountRepository: Repository<FdAccount>,
    ) { }

    async findAll(): Promise<FdAccount[]> {
        this.logger.log('[FdAccount] GET all FD accounts');
        // BUG FIX: must filter fdrdflag='F' — without this, RD accounts appear in the FD dropdown
        const accounts = await this.fdAccountRepository.find({
            where: { fdrdflag: 'F' },
            order: { accountNumber: 'ASC' }
        });
        this.logger.log(`[FdAccount] Found ${accounts.length} FD accounts`);
        return accounts;
    }

    async findByMember(memberNo: number): Promise<FdAccount[]> {
        this.logger.log(`[FdAccount] Finding FD accounts for member: ${memberNo}`);
        // BUG FIX: must filter fdrdflag='F'
        const accounts = await this.fdAccountRepository.find({
            where: { memberNo, fdrdflag: 'F' },
            order: { accountNumber: 'ASC' }
        });
        this.logger.log(`[FdAccount] Found ${accounts.length} FD accounts for member ${memberNo}`);
        return accounts;
    }

    async findOne(accountNumber: number): Promise<FdAccount> {
        this.logger.log(`[FdAccount] GET account: ${accountNumber}`);
        // BUG FIX: must filter fdrdflag='F' to prevent accidentally loading/patching an RD account
        const fdAccount = await this.fdAccountRepository.findOne({ where: { accountNumber, fdrdflag: 'F' } });
        if (!fdAccount) {
            throw new NotFoundException(`FD Account ${accountNumber} not found`);
        }
        return fdAccount;
    }

    async update(accountNumber: number, updateDto: UpdateFdAccountDto): Promise<FdAccount> {
        this.logger.log(`[FdAccount] PATCH account: ${accountNumber}`);
        const fdAccount = await this.findOne(accountNumber);
        Object.assign(fdAccount, updateDto);
        const saved = await this.fdAccountRepository.save(fdAccount);
        this.logger.log(`[FdAccount] Saved account: ${accountNumber}`);
        return saved;
    }
}
