import { Injectable, NotFoundException, ConflictException, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { SbAccount } from '../entities/sb-account.entity';
import { CreateSbAccountDto, UpdateSbAccountDto } from '../dto/sb-account.dto';
import { generateVoucherNo } from '../../shared/utils/voucher-utils';

@Injectable()
export class SbAccountService {
    private readonly logger = new Logger(SbAccountService.name);

    constructor(
        @InjectRepository(SbAccount)
        private readonly sbAccountRepository: Repository<SbAccount>,
        private readonly dataSource: DataSource,
    ) { }

    // The legacy DB ships without an sbmaster table. Create it on first use (idempotent,
    // non-destructive). Columns are the union of what opening, deposit/withdrawal, search and
    // getSavingAccountDetails all reference — so every consumer works off one real table.
    private async ensureTable(runner?: { query: (sql: string, params?: any[]) => Promise<any> }): Promise<void> {
        const exec = runner ?? this.sbAccountRepository;
        await exec.query(`
            CREATE TABLE IF NOT EXISTS sbmaster (
                acc_no            VARCHAR(20) PRIMARY KEY,
                mbno              VARCHAR(20) NOT NULL,
                opening_date      DATE,
                opening_balance   NUMERIC(18,2) DEFAULT 0,
                balance           NUMERIC(18,2) DEFAULT 0,
                min_balance       NUMERIC(18,2) DEFAULT 0,
                unpass_cr         NUMERIC(18,2) DEFAULT 0,
                unpass_dr         NUMERIC(18,2) DEFAULT 0,
                ledger_group      VARCHAR(50),
                instructions      TEXT,
                status            VARCHAR(20) DEFAULT 'Active',
                mode_of_operation VARCHAR(50),
                operators         TEXT,
                nominee_name      VARCHAR(100),
                nominee_age       VARCHAR(10),
                nominee_address   VARCHAR(255),
                nominee_relation  VARCHAR(50)
            )
        `);
    }

    // FIX 1: auto-generate the next SB account number (MAX numeric acc_no + 1).
    async getNextAccountNumber(): Promise<{ nextAccountNumber: string }> {
        await this.ensureTable();
        const rows = await this.sbAccountRepository.query(
            `SELECT COALESCE(MAX(acc_no::bigint), 0) + 1 AS next
             FROM sbmaster WHERE acc_no ~ '^[0-9]+$'`
        );
        return { nextAccountNumber: String(rows[0]?.next ?? '1') };
    }

    async create(createDto: CreateSbAccountDto): Promise<SbAccount> {
        const queryRunner = this.dataSource.createQueryRunner();
        await queryRunner.connect();
        await queryRunner.startTransaction();
        try {
            await this.ensureTable(queryRunner);

            // FIX 1: never let TypeORM's save() silently UPDATE an existing PK — reject duplicates.
            const dup = await queryRunner.query(`SELECT 1 FROM sbmaster WHERE acc_no = $1`, [createDto.accountNo]);
            if (dup && dup.length > 0) {
                throw new ConflictException(`Account number ${createDto.accountNo} already exists`);
            }

            const openingDate = createDto.openingDate ? new Date(createDto.openingDate) : new Date();
            const openingBalance = Number(createDto.openingBalance) || 0;

            const inserted = await queryRunner.query(
                `INSERT INTO sbmaster (acc_no, mbno, opening_date, opening_balance, balance, ledger_group,
                                       instructions, status, nominee_name, nominee_age, nominee_address, nominee_relation)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, 'Active', $8, $9, $10, $11)
                 RETURNING *`,
                [
                    createDto.accountNo, createDto.memberNo, openingDate, openingBalance, openingBalance,
                    createDto.ledgerGroup || null, createDto.specialInstructions || null,
                    createDto.nomineeName || null, createDto.nomineeAge || null,
                    createDto.nomineeAddress || null, createDto.nomineeRelation || null,
                ]
            );

            // FIX 3: post the opening balance to the ledger so the account shows up in balance/reports
            // immediately (reports read the ledger, not sbmaster). Treated as a cash opening receipt:
            // CR the Savings Bank control head (A001), DR Cash in Hand (A1001).
            if (openingBalance > 0) {
                const voucherNo = await generateVoucherNo(queryRunner, 'R');
                const maxRes = await queryRunner.query(
                    `SELECT COALESCE(MAX(trans_no), 0) + 1 AS next_trans_no, COALESCE(MAX(ledgerid), 0) + 1 AS next_ledger_id FROM ledger`
                );
                const nextTransNo = Number(maxRes[0]?.next_trans_no ?? 1);
                const nextLedgerId = Number(maxRes[0]?.next_ledger_id ?? 1);

                // Member SB leg — CR (balance increases)
                await queryRunner.query(
                    `INSERT INTO ledger (trans_no, trans_date, trans_type, code, mbno, acc_no, acc_type, trans_amt,
                                         receipt_vchr_no, vchr_type, modeofpay, pl_balance, narration, username, ledgerid)
                     VALUES ($1, $2, 'CR', 'A001', $3, $4, 'SB', $5, $6, 'R', 'C', 0, 'Opening Balance', 'system', $7)`,
                    [nextTransNo, openingDate, createDto.memberNo, createDto.accountNo, openingBalance, voucherNo, nextLedgerId]
                );
                // Cash in Hand contra leg — DR
                await queryRunner.query(
                    `INSERT INTO ledger (trans_no, trans_date, trans_type, code, mbno, acc_no, acc_type, trans_amt,
                                         receipt_vchr_no, vchr_type, modeofpay, pl_balance, narration, username, ledgerid)
                     VALUES ($1, $2, 'DR', 'A1001', $3, 0, 'CINH', $4, $5, 'R', 'C', 0, 'Opening Balance', 'system', $6)`,
                    [nextTransNo + 1, openingDate, createDto.memberNo, openingBalance, voucherNo, nextLedgerId + 1]
                );
                this.logger.log(`[SB Open] acc=${createDto.accountNo} opening=${openingBalance} posted vchr=${voucherNo}`);
            }

            await queryRunner.commitTransaction();
            return inserted[0];
        } catch (err) {
            await queryRunner.rollbackTransaction();
            throw err;
        } finally {
            await queryRunner.release();
        }
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
