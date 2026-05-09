import { Injectable, NotFoundException, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { RdAccount } from '../entities/rd-account.entity';
import { CreateRdAccountDto, UpdateRdAccountDto } from '../dto/rd-account.dto';

@Injectable()
export class RdAccountService {
    private readonly logger = new Logger(RdAccountService.name);

    constructor(
        @InjectRepository(RdAccount)
        private readonly rdAccountRepository: Repository<RdAccount>,
    ) { }

    async create(createDto: CreateRdAccountDto): Promise<any> {
        this.logger.log(`Creating RD Account: ${createDto.accountNumber} for member: ${createDto.memberNo}`);
        // Use raw query to insert into fdmaster with fdrdflag='R'
        const result = await this.rdAccountRepository.query(
            `INSERT INTO fdmaster (
                account_number, mbno, prefix, f_name, m_name, l_name,
                depdate, fdamount, rate, depperiod, depunit,
                matdate, matamount, status, nominee, nage, naddr, nrelation,
                remarks, fdrdflag, interestpayamentmode,
                interestbalance, interestamount, intpaid, openbal
            ) VALUES (
                $1, $2, $3, $4, $5, $6,
                $7, $8, $9, $10, $11,
                $12, $13, $14, $15, $16, $17, $18,
                $19, 'R', 1,
                0, 0, 0, 0
            ) RETURNING *`,
            [
                createDto.accountNumber,
                createDto.memberNo,
                createDto.prefix || '',
                createDto.firstName || '',
                createDto.middleName || '',
                createDto.lastName || '',
                createDto.depositDate || null,
                createDto.amount || 0,
                createDto.rate || 0,
                createDto.depositPeriod || 0,
                createDto.depositUnit || 1,
                createDto.maturityDate || null,
                createDto.maturityAmount || 0,
                '0',  // status: 0 = Active
                createDto.nominee || '',
                createDto.nomineeAge || '',
                createDto.nomineeAddress || '',
                createDto.nomineeRelation || '',
                createDto.specialInstructions || '',
            ]
        );
        this.logger.log(`RD Account created: account=${createDto.accountNumber}, member=${createDto.memberNo}, amount=${createDto.amount}`);
        return result[0];
    }

    async findAll(memberNo?: string): Promise<any[]> {
        this.logger.log(`Fetching RD accounts${memberNo ? ` for member: ${memberNo}` : ''}`);
        if (memberNo) {
            return await this.rdAccountRepository.query(
                `SELECT * FROM fdmaster WHERE fdrdflag = 'R' AND mbno = $1 ORDER BY account_number`,
                [memberNo]
            );
        }
        return await this.rdAccountRepository.query(
            `SELECT * FROM fdmaster WHERE fdrdflag = 'R' ORDER BY account_number`
        );
    }

    async findOne(id: number): Promise<RdAccount> {
        this.logger.log(`Fetching RD account: ${id}`);
        const rdAccount = await this.rdAccountRepository.findOne({ where: { accountNumber: id } });
        if (!rdAccount) {
            throw new NotFoundException(`RD Account with ID ${id} not found`);
        }
        return rdAccount;
    }

    async update(id: number, updateDto: UpdateRdAccountDto): Promise<any> {
        this.logger.log(`Updating RD account: ${id}`);
        const result = await this.rdAccountRepository.query(
            `UPDATE fdmaster SET
                mbno = COALESCE($2, mbno),
                f_name = COALESCE($3, f_name),
                depdate = COALESCE($4, depdate),
                fdamount = COALESCE($5, fdamount),
                rate = COALESCE($6, rate),
                depperiod = COALESCE($7, depperiod),
                depunit = COALESCE($8, depunit),
                matdate = COALESCE($9, matdate),
                matamount = COALESCE($10, matamount),
                remarks = COALESCE($11, remarks)
            WHERE account_number = $1 AND fdrdflag = 'R'
            RETURNING *`,
            [
                id,
                updateDto.memberNo || null,
                updateDto.firstName || null,
                updateDto.depositDate || null,
                updateDto.amount || null,
                updateDto.rate || null,
                updateDto.depositPeriod || null,
                updateDto.depositUnit || null,
                updateDto.maturityDate || null,
                updateDto.maturityAmount || null,
                updateDto.specialInstructions || null,
            ]
        );
        if (!result || result.length === 0) {
            throw new NotFoundException(`RD Account with ID ${id} not found`);
        }
        return result[0];
    }

    async remove(id: number): Promise<void> {
        this.logger.log(`Removing RD account: ${id}`);
        const result = await this.rdAccountRepository.delete(id);
        if (result.affected === 0) {
            throw new NotFoundException(`RD Account with ID ${id} not found`);
        }
    }
}
