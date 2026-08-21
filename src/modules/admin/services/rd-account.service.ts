import { Injectable, NotFoundException, ConflictException, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, DataSource } from 'typeorm';
import { RdAccount } from '../entities/rd-account.entity';
import { CreateRdAccountDto, UpdateRdAccountDto } from '../dto/rd-account.dto';

@Injectable()
export class RdAccountService {
    private readonly logger = new Logger(RdAccountService.name);

    constructor(
        @InjectRepository(RdAccount)
        private readonly rdAccountRepository: Repository<RdAccount>,
        private readonly dataSource: DataSource,
    ) { }

    async create(createDto: CreateRdAccountDto): Promise<any> {
        this.logger.log(`Creating RD Account: ${createDto.accountNumber} for member: ${createDto.memberNo}`);

        const queryRunner = this.dataSource.createQueryRunner();
        await queryRunner.connect();
        await queryRunner.startTransaction();

        try {
            // BUG FIX 47: account_number is fetched by the frontend via a separate,
            // earlier GET /next-number call and then trusted as-is at insert time —
            // a real time-of-check-to-time-of-use gap (no re-check here at all), and
            // there's no unique constraint on account_number to catch a collision at
            // the DB level. Worse: this number space is shared with FD, whose own
            // generator (utilities.service.ts createFixedDepositReceipt) computes its
            // next number from FD-only rows and ignores RD's entirely (and vice versa
            // here) — so two accounts can land on the same account_number even
            // without any raciness at all. Locking + a fresh existence check across
            // the whole table (not just fdrdflag='R') under that lock closes both gaps
            // for this side; the same check was added to FD's creator too.
            await queryRunner.query(`SELECT pg_advisory_xact_lock(hashtext('fdmaster_account_number'))`);
            const dup = await queryRunner.query(
                `SELECT fdrdflag FROM fdmaster WHERE account_number = $1`, [createDto.accountNumber]
            );
            if (dup.length > 0) {
                throw new ConflictException(
                    `Account number ${createDto.accountNumber} is already in use (${dup[0].fdrdflag === 'F' ? 'by an FD account' : 'by another RD account'}). Refresh and try again.`
                );
            }

            const result = await queryRunner.query(
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
                    // BUG FIX 47: this DTO field was persisted to rd_by_demand, while a
                    // separate helper (ensureRecoveryColumn, now removed) migrated a
                    // *different*, never-written column (recovery_through_demand) —
                    // dead code implying the wrong column was the real target. Nothing
                    // else in the codebase reads recovery_through_demand, so rd_by_demand
                    // (below) remains the single real target.
                    createDto.recoveryThroughDemand ? 'Y' : 'N',
                    createDto.headCode || '',
                ]
            );

            await queryRunner.commitTransaction();
            this.logger.log(`RD Account created: account=${createDto.accountNumber}, member=${createDto.memberNo}, amount=${createDto.amount}`);
            return result[0];
        } catch (error) {
            await queryRunner.rollbackTransaction();
            throw error;
        } finally {
            await queryRunner.release();
        }
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
        // BUG FIX: `updateDto.field || null` treated an explicitly-sent falsy value
        // (0, or an empty string used to clear a text field) the same as "field not
        // provided" — COALESCE then silently kept the OLD value while the endpoint
        // still returned 200 success. Confirmed live: clearing `specialInstructions`
        // to "" had no effect, repeatedly. Fixed with explicit `!== undefined` checks
        // so a real 0/"" is respected, and only a genuinely-omitted field is skipped.
        const v = <T>(x: T | undefined) => (x !== undefined ? x : null);
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
                v(updateDto.memberNo),
                v(updateDto.prefix),
                v(updateDto.firstName),
                v(updateDto.middleName),
                v(updateDto.lastName),
                v(updateDto.depositDate),
                v(updateDto.amount),
                v(updateDto.rate),
                v(updateDto.depositPeriod),
                v(updateDto.depositUnit),
                v(updateDto.maturityDate),
                v(updateDto.maturityAmount),
                v(updateDto.nominee),
                v(updateDto.nomineeAge),
                v(updateDto.nomineeAddress),
                v(updateDto.nomineeRelation),
                v(updateDto.specialInstructions),
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
