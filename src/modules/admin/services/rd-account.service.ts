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

    // BUG FIX 6: 'Recovery Through Demand' had no column in fdmaster, so the checkbox was silently
    // dropped. Ensure a nullable boolean column exists (idempotent, non-destructive) before insert.
    private async ensureRecoveryColumn(): Promise<void> {
        await this.rdAccountRepository.query(
            `ALTER TABLE fdmaster ADD COLUMN IF NOT EXISTS recovery_through_demand BOOLEAN DEFAULT false`
        );
    }

    async create(createDto: CreateRdAccountDto): Promise<any> {
        this.logger.log(`Creating RD Account: ${createDto.accountNumber} for member: ${createDto.memberNo}`);
        const result = await this.rdAccountRepository.query(
            `INSERT INTO fdmaster (
                account_number, mbno, prefix, f_name, m_name, l_name,
                depdate, fdamount, rate, depperiod, depunit,
                matdate, matamount, status, nominee, nage, naddr, nrelation,
                remarks, fdrdflag, interestpayamentmode,
                interestbalance, interestamount, intpaid, openbal,
                rd_by_demand, headcode
            ) VALUES (
                $1, $2, $3, $4, $5, $6,
                $7, $8, $9, $10, $11,
                $12, $13, $14, $15, $16, $17, $18,
                $19, 'R', 1,
                0, 0, 0, $20,
                $21, $22
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
                '0',
                createDto.nominee || '',
                createDto.nomineeAge || '',
                createDto.nomineeAddress || '',
                createDto.nomineeRelation || '',
                createDto.specialInstructions || '',
                createDto.openingBalance || 0,
                createDto.recoveryThroughDemand ? 'Y' : 'N',
                createDto.headCode || '',
            ]
        );
        this.logger.log(`RD Account created: account=${createDto.accountNumber}, member=${createDto.memberNo}, amount=${createDto.amount}`);
        return result[0];
    }

    async getNextAccountNumber(): Promise<{ nextAccountNumber: number }> {
        const rows = await this.rdAccountRepository.query(
            `SELECT COALESCE(MAX(account_number), 0) + 1 AS next FROM fdmaster`
        );
        return { nextAccountNumber: parseInt(rows[0]?.next ?? '1', 10) };
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

    async findOne(id: number): Promise<any> {
        this.logger.log(`Fetching RD account: ${id}`);
        // BUG FIX 1: was using TypeORM findOne() with no fdrdflag='R' filter —
        // could silently return an FD record (fdrdflag='F') with the same account_number.
        const rows = await this.rdAccountRepository.query(
            `SELECT * FROM fdmaster WHERE account_number = $1 AND fdrdflag = 'R'`,
            [id]
        );
        if (!rows || rows.length === 0) {
            throw new NotFoundException(`RD Account with ID ${id} not found`);
        }
        return rows[0];
    }

    async update(id: number, updateDto: UpdateRdAccountDto): Promise<any> {
        this.logger.log(`Updating RD account: ${id}`);
        // BUG FIX 9: original query was missing prefix, m_name, l_name, nominee columns.
        // All COALESCE($n, col) so omitted fields keep their existing DB value.
        const result = await this.rdAccountRepository.query(
            `UPDATE fdmaster SET
                mbno        = COALESCE($2,  mbno),
                prefix      = COALESCE($3,  prefix),
                f_name      = COALESCE($4,  f_name),
                m_name      = COALESCE($5,  m_name),
                l_name      = COALESCE($6,  l_name),
                depdate     = COALESCE($7,  depdate),
                fdamount    = COALESCE($8,  fdamount),
                rate        = COALESCE($9,  rate),
                depperiod   = COALESCE($10, depperiod),
                depunit     = COALESCE($11, depunit),
                matdate     = COALESCE($12, matdate),
                matamount   = COALESCE($13, matamount),
                nominee     = COALESCE($14, nominee),
                nage        = COALESCE($15, nage),
                naddr       = COALESCE($16, naddr),
                nrelation   = COALESCE($17, nrelation),
                remarks     = COALESCE($18, remarks)
            WHERE account_number = $1 AND fdrdflag = 'R'
            RETURNING *`,
            [
                id,
                updateDto.memberNo       || null,
                updateDto.prefix         || null,
                updateDto.firstName      || null,
                updateDto.middleName     || null,
                updateDto.lastName       || null,
                updateDto.depositDate    || null,
                updateDto.amount         || null,
                updateDto.rate           || null,
                updateDto.depositPeriod  || null,
                updateDto.depositUnit    || null,
                updateDto.maturityDate   || null,
                updateDto.maturityAmount || null,
                updateDto.nominee        || null,
                updateDto.nomineeAge     || null,
                updateDto.nomineeAddress || null,
                updateDto.nomineeRelation|| null,
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
        // BUG FIX 2: was using TypeORM delete() which had no fdrdflag='R' filter —
        // could accidentally delete an FD record sharing the same account_number.
        // RETURNING lets us detect whether the row actually existed.
        const rows = await this.rdAccountRepository.query(
            `DELETE FROM fdmaster WHERE account_number = $1 AND fdrdflag = 'R' RETURNING account_number`,
            [id]
        );
        if (!rows || rows.length === 0) {
            throw new NotFoundException(`RD Account with ID ${id} not found`);
        }
    }
}
