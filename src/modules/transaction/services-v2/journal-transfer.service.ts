import { Injectable, Logger, BadRequestException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { CreateJournalVoucherDto } from '../dto/journal-transfer.dto';

@Injectable()
export class JournalTransferService {
    private readonly logger = new Logger(JournalTransferService.name);

    constructor(private readonly dataSource: DataSource) { }

    /**
     * Post a balancing Journal Entry
     */
    async postJournalEntry(dto: CreateJournalVoucherDto, username: string = 'admin') {
        // 1. Validate Balance
        const totalDebit = dto.rows.reduce((sum, row) => sum + row.debit, 0);
        const totalCredit = dto.rows.reduce((sum, row) => sum + row.credit, 0);

        if (Math.abs(totalDebit - totalCredit) > 0.01) {
            throw new BadRequestException(`Unbalanced Journal Entry: Total Debit (₹${totalDebit}) must equal Total Credit (₹${totalCredit})`);
        }

        const queryRunner = this.dataSource.createQueryRunner();
        await queryRunner.connect();
        await queryRunner.startTransaction();

        try {
            // 2. Get Next Journal Voucher Number from getworkingdate
            const workingDateRes = await queryRunner.query(`SELECT journal_voucher, working_date FROM getworkingdate LIMIT 1`);
            const voucherNo = (workingDateRes[0]?.journal_voucher || 1).toString();

            // 3. Create Voucher Header
            const nextVchrId = await this.getNextId(queryRunner, 'vouchers', 'id');
            await queryRunner.query(`
                INSERT INTO vouchers (
                    id, "voucherNumber", "voucherDate", "voucherType", "totalAmount", 
                    description, status, "remarks", "createdAt"
                ) VALUES ($1, $2, $3, 'JOURNAL', $4, $5, 'POSTED', $6, NOW())
            `, [
                nextVchrId,
                voucherNo,
                workingDateRes[0]?.working_date || new Date(),
                totalDebit,
                dto.narration,
                dto.chequeNo || 'JOURNAL_TRANSFER'
            ]);

            // 4. Update Voucher Number in getworkingdate
            await queryRunner.query(`UPDATE getworkingdate SET journal_voucher = journal_voucher + 1`);

            // 5. Post Transaction Rows
            let currentTransNo = await this.getNextId(queryRunner, 'transactions', 'trans_no');

            for (const row of dto.rows) {
                const amount = row.debit > 0 ? row.debit : row.credit;
                const type = row.debit > 0 ? 'P' : 'R'; // P for Debit (Payment), R for Credit (Receipt)

                // a. Base Transaction
                await queryRunner.query(`
                    INSERT INTO transactions (
                        trans_no, trans_type, trans_date, mbno, trans_amt, receipt_vchr_no, 
                        vchr_type, modeofpay, pass_flag, cashier_flag, code, narration, username, cheq_no, cheq_amt
                    ) VALUES ($1, $2, NOW(), $3, $4, $5, 'JV', 'J', 'Y', 'Y', $6, $7, $8, $9, 0)
                `, [
                    currentTransNo++,
                    type,
                    row.mbno || null,
                    amount,
                    voucherNo,
                    row.code || null,
                    row.narration || dto.narration,
                    username,
                    dto.chequeNo
                ]);

                // b. If Member Involved, post to Ledger and update Member Balances
                if (row.mbno) {
                    const ledgerId = await this.getNextId(queryRunner, 'ledger', 'ledgerid');

                    // Determine Account Head Logic
                    let balanceColumn = '';
                    let accountType = 'LIABILITY'; // Default: Credit increases balance (Deposits)

                    // Map Code to Member Balance Column
                    const codeUpper = (row.code || '').toUpperCase();
                    if (['CD', 'THRIFT', 'D'].includes(codeUpper)) {
                        balanceColumn = 'compulsory_deposit';
                    } else if (['SH', 'SHARE', 'S'].includes(codeUpper)) {
                        balanceColumn = 'shares';
                    } else if (['RD', 'R'].includes(codeUpper)) {
                        balanceColumn = 'rd_amt';
                    } else if (['RL', 'LOAN', 'L', 'REGULAR'].includes(codeUpper)) {
                        balanceColumn = 'regularloan';
                        accountType = 'ASSET'; // Credit decreases balance (Repayment)
                    } else if (['EL', 'EMERGENCY', 'E'].includes(codeUpper)) {
                        balanceColumn = 'emergency_loan_balance';
                        accountType = 'ASSET';
                    }

                    // Calculate New Balance (Logical simplified balance for Ledger, just for record)
                    // Note: 'member_balances' is the master record. Ledger 'pl_balance' is snapshot.
                    let currentBal = 0;
                    if (balanceColumn) {
                        const balRes = await queryRunner.query(`SELECT ${balanceColumn} FROM member_balances WHERE mbno = $1`, [row.mbno]);
                        if (balRes && balRes[0]) {
                            currentBal = parseFloat(balRes[0][balanceColumn] || '0');
                        }
                    }

                    // Apply Logic:
                    // LIABILITY (Deposits): Credit (R) -> Add, Debit (P) -> Subtract
                    // ASSET (Loans): Credit (R) -> Subtract, Debit (P) -> Add
                    let newBal = currentBal;
                    if (balanceColumn) {
                        if (accountType === 'LIABILITY') {
                            newBal = type === 'R' ? currentBal + amount : currentBal - amount;
                        } else {
                            // Asset: Payment (P/Debit) increases loan (New Loan)
                            //        Receipt (R/Credit) decreases loan (Repayment)
                            newBal = type === 'R' ? currentBal - amount : currentBal + amount;
                        }

                        // Update Master Balance
                        await queryRunner.query(`
                            UPDATE member_balances 
                            SET ${balanceColumn} = $1 
                            WHERE mbno = $2
                        `, [newBal, row.mbno]);
                    }

                    // Insert Ledger Record
                    await queryRunner.query(`
                        INSERT INTO ledger (
                            trans_date, trans_type, mbno, trans_amt, receipt_vchr_no, 
                            vchr_type, pl_balance, narration, username, ledgerid, code
                        ) VALUES (NOW(), $1, $2, $3, $4, 'JV', $5, $6, $7, $8, $9)
                    `, [
                        type,
                        row.mbno,
                        amount,
                        voucherNo,
                        newBal, // Snapshot balance after transaction
                        row.narration || dto.narration,
                        username,
                        ledgerId,
                        row.code
                    ]);
                }
            }

            await queryRunner.commitTransaction();
            return {
                success: true,
                message: `Journal entry posted successfully. Voucher No: ${voucherNo}`,
                voucherNo
            };

        } catch (error) {
            await queryRunner.rollbackTransaction();
            this.logger.error('Journal Posting Failed', error);
            throw error;
        } finally {
            await queryRunner.release();
        }
    }

    private async getNextId(queryRunner: any, table: string, col: string): Promise<number> {
        const res = await queryRunner.query(`SELECT COALESCE(MAX(${col}), 0) + 1 as next_id FROM ${table}`);
        return parseInt(res[0].next_id);
    }
}
