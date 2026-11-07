import { BadRequestException, HttpException, Injectable, NotFoundException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { SequenceGeneratorService } from '../../shared/services';
import { NotificationService } from '../../notification/services/notification.service';
import { NotificationChannel } from '../../notification/entities/notification-log.entity';
import { parseBusinessDate } from '../../shared/utils/date-utils';
import { LoanReagreementService } from '../../loan/services-v2/reagreement/loan-reagreement.service';

/** Voucher types this service stages; anything else is refused (ES-313) */
const VOUCHER_TYPES = ['RECEIPT', 'PAYMENT'];
/** One voucher line can not reach 100 crore (a typo guard, ES-313) */
const MAX_VOUCHER_AMOUNT = 999_999_999.99;
const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

/**
 * Voucher Service - Handles voucher generation and staging.
 * 
 * @version 2.2 - Refactored to use standard legacy tables (vouchers, transactions)
 * to comply with "no new table" constraint.
 */
@Injectable()
export class VoucherService {
    constructor(
        private readonly dataSource: DataSource,
        private readonly sequenceGenerator: SequenceGeneratorService,
        private readonly notificationService: NotificationService,
        private readonly reagreementService: LoanReagreementService,
    ) { }

    /**
     * Create a generic voucher (Payment, Receipt, etc.)
     * Uses 'vouchers' and 'transactions' tables
     */
    async createVoucher(dto: any) {
        const queryRunner = this.dataSource.createQueryRunner();

        try {
            await queryRunner.connect();
            await queryRunner.startTransaction();

            console.log(`[Voucher] 🚀 Creating generic ${dto.voucherType} voucher:`, dto);

            // Normalize: accept 'transactions' or 'breakdown' from frontend callers
            const transactions: any[] = Array.isArray(dto.transactions)
                ? dto.transactions
                : Array.isArray(dto.breakdown)
                    ? dto.breakdown
                    : [];

            if (transactions.length === 0) {
                throw new BadRequestException('No transaction entries provided. At least one entry is required.');
            }

            const voucherType = String(dto.voucherType ?? '').trim().toUpperCase();
            if (!VOUCHER_TYPES.includes(voucherType)) {
                throw new BadRequestException(`voucherType must be one of ${VOUCHER_TYPES.join(', ')}.`);
            }
            dto.voucherType = voucherType;
            // the user who stages the voucher (the controller sets it from the signed-in user)
            const createdBy = String(dto.createdBy || 'SYSTEM').trim() || 'SYSTEM';

            // Entry validation: bad input is a 400, never a 500 from a failed INSERT. (ES-314)
            for (const [i, t] of transactions.entries()) {
                if (typeof t.amount === 'string' ? t.amount.trim() === '' || !Number.isFinite(Number(t.amount)) : typeof t.amount !== 'number' || !Number.isFinite(t.amount)) {
                    throw new BadRequestException(`Entry ${i + 1}: amount must be a number.`);
                }
                t.amount = Number(t.amount);
                if (t.amount <= 0 || t.amount > MAX_VOUCHER_AMOUNT) {
                    throw new BadRequestException(`Entry ${i + 1}: amount must be greater than 0 and not more than ${MAX_VOUCHER_AMOUNT}.`);
                }
            }
            // amounts are rupees and paise: at most 2 decimals (ES-313)
            for (const [i, t] of transactions.entries()) {
                if (Math.abs(Math.round(t.amount * 100) - t.amount * 100) > 1e-6) {
                    throw new BadRequestException(`Entry ${i + 1}: amount can have at most 2 decimal places.`);
                }
            }
            dto.voucherDate = parseBusinessDate(dto.voucherDate, 'Voucher date');
            if (dto.chequeDate) dto.chequeDate = parseBusinessDate(dto.chequeDate, 'Cheque date', 365);
            if (dto.memberId !== undefined && dto.memberId !== null && dto.memberId !== '') {
                const member = await queryRunner.query(`SELECT mbno FROM member_master WHERE mbno::text = $1 LIMIT 1`, [String(dto.memberId).trim()]);
                if (member.length === 0) throw new BadRequestException(`Member ${dto.memberId} not found.`);
            }
            const entryCodes = [...new Set(transactions.map((t: any) => (t.debitAccount || t.code || '').toString().trim()).filter(Boolean))];
            if (entryCodes.length > 0) {
                const known = await queryRunner.query(`SELECT TRIM(code) AS code FROM headmaster WHERE TRIM(code) = ANY($1)`, [entryCodes]);
                const knownSet = new Set(known.map((h: any) => h.code.toString().trim()));
                const unknown = entryCodes.filter(c => !knownSet.has(c));
                if (unknown.length > 0) throw new BadRequestException(`Unknown head code(s): ${unknown.join(', ')}`);
            }

            // 1. Get sequential voucher number
            const voucherNumber = await this.sequenceGenerator.getNextVoucherNumber();

            // 2. Insert into 'vouchers' table
            const voucherHeaderQuery = `
                INSERT INTO vouchers (
                    "id", "voucherNumber", "voucherDate", "voucherType", "totalAmount", 
                    "description", "memberId", "payeeName", "status", "remarks", 
                    "chequeNumber", "chequeDate", "bankName", "createdAt"
                ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
            `;

            const nextVoucherId = await this.getNextId(queryRunner, 'vouchers');
            const totalAmount = round2(transactions.reduce((sum: number, t: any) => sum + (t.amount || 0), 0));

            await queryRunner.query(voucherHeaderQuery, [
                nextVoucherId,
                voucherNumber,
                dto.voucherDate || new Date(),
                dto.voucherType,
                totalAmount,
                dto.description,
                dto.memberId || null,
                dto.payeeName || '',
                'PENDING',
                dto.remarks || '',
                dto.chequeNumber || null,
                dto.chequeDate || null,
                dto.bankName || null,
                new Date()
            ]);

            // 3. Insert breakdown into 'transactions' table
            for (const entry of transactions) {
                const transNo = await this.getNextId(queryRunner, 'transactions');
                const transQuery = `
                    INSERT INTO transactions (
                        trans_no, trans_type, trans_date, mbno, trans_amt, 
                        receipt_vchr_no, vchr_type, modeofpay, pass_flag, cashier_flag,
                        narration, code, username, acc_no, cheq_amt
                    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
                `;

                await queryRunner.query(transQuery, [
                    transNo,
                    dto.voucherType === 'PAYMENT' ? 'P' : 'R', // P for Payment, R for Receipt
                    dto.voucherDate || new Date(),
                    dto.memberId || null,
                    entry.amount,
                    voucherNumber,
                    dto.voucherType === 'PAYMENT' ? 'PV' : 'RV', // PV: Payment Voucher, RV: Receipt Voucher
                    dto.paymentMethod === 'CASH' ? 'C' : 'B',
                    'N', // pass_flag (pending approval)
                    'N', // cashier_flag
                    entry.description || dto.description,
                    entry.debitAccount || entry.code || null,
                    createdBy,
                    entry.rdSrNo ? parseInt(entry.rdSrNo.replace(/[^0-9]/g, '')) || null : null,
                    0 // cheq_amt default
                ]);
            }

            // ES-50: add the balancing cash/bank leg. Only the operator's lines were staged before, so
            // Cash in Hand / the bank head never moved. Receipt: DR cash/bank. Payment: CR cash/bank.
            const isCashMode = dto.paymentMethod === 'CASH';
            const counterCode = isCashMode ? 'A1001' : (dto.bankCode || dto.receiveIntoCode);
            if (!counterCode) {
                throw new BadRequestException('Bank mode requires bankCode (the bank head to debit/credit).');
            }
            const isReceipt = dto.voucherType !== 'PAYMENT';
            const counterTransNo = await this.getNextId(queryRunner, 'transactions');
            await queryRunner.query(`
                INSERT INTO transactions (
                    trans_no, trans_type, trans_date, mbno, trans_amt,
                    receipt_vchr_no, vchr_type, modeofpay, pass_flag, cashier_flag,
                    narration, code, username, cheq_amt, acc_type
                ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'N', 'N', $9, $10, $12, 0, $11)
            `, [
                counterTransNo,
                isReceipt ? 'DR' : 'CR',
                dto.voucherDate || new Date(),
                dto.memberId || null,
                totalAmount,
                voucherNumber,
                isReceipt ? 'RV' : 'PV',
                isCashMode ? 'C' : 'B',
                dto.description,
                counterCode,
                counterCode === 'A1001' ? 'CINH' : 'BANK',
                createdBy,
            ]);

            await queryRunner.commitTransaction();
            console.log(`[Voucher] ✅ Generic voucher ${voucherNumber} created successfully`);

            // No member notification here: the voucher is only staged (PENDING) and may still be rejected, so telling
            // the member "processed" now would be wrong (ES-413). The member is to be told when the voucher is passed.

            return {
                success: true,
                message: 'Voucher created successfully',
                voucherNo: voucherNumber
            };

        } catch (error: any) {
            await queryRunner.rollbackTransaction();
            console.error('[Voucher] ❌ Error creating generic voucher:', error);
            throw error instanceof HttpException ? error : new Error('Failed to create voucher: ' + error.message);
        } finally {
            await queryRunner.release();
        }
    }

    /**
     * Generate voucher for loan disbursement
     * Uses 'vouchers' table and 'transactions' table (pending)
     */
    async generateLoanVoucher(voucherData: any) {
        // A re-agreement is not a disbursement: it collects NR interest + penalty and moves no principal.
        if (await this.reagreementService.isReagreementCase(this.dataSource, voucherData.loanCaseNo)) {
            return this.reagreementService.createVoucher(String(voucherData.loanCaseNo), {
                paymentMode: voucherData.paymentMode, bankName: voucherData.bankName,
                chequeNo: voucherData.chequeNo, chequeDate: voucherData.chequeDate, narration: voucherData.narration,
            }, { actor: voucherData.createdBy || 'admin' });
        }
        const queryRunner = this.dataSource.createQueryRunner();

        try {
            await queryRunner.connect();
            await queryRunner.startTransaction();

            console.log('[Voucher] 🎯 Generating voucher for loan disbursement using standard tables:', voucherData);

            // One pending voucher per loan case: the lock makes two requests for the same case wait for each other,
            // so they cannot both pass the "no pending voucher" check below (ES-319).
            await queryRunner.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`loan_voucher:${voucherData.loanCaseNo}`]);
            const pendingForCase = await queryRunner.query(
                `SELECT "voucherNumber" FROM vouchers WHERE "remarks" LIKE $1 AND status = 'PENDING' LIMIT 1`,
                [`LOAN_CASE:${voucherData.loanCaseNo}|%`],
            );
            if (pendingForCase.length > 0) {
                throw new BadRequestException(`Loan case ${voucherData.loanCaseNo} already has a pending voucher (${pendingForCase[0].voucherNumber}). Pass or reject it first.`);
            }

            // 1. Get sequential voucher number
            const voucherNumber = await this.sequenceGenerator.getNextVoucherNumber();

            // 2. Validate loan case exists and is sanctioned
            const loanQuery = `
                SELECT loancaseno, mbno, sanctioned_amt, flg_sanctioned, flg_paid, loantype, purpose
                FROM loan_pending 
                WHERE loancaseno = $1 AND flg_sanctioned = 'Y' AND flg_paid = 'N'
            `;

            const loanResult = await queryRunner.query(loanQuery, [voucherData.loanCaseNo]);
            if (loanResult.length === 0) {
                throw new BadRequestException('Loan case not found or not sanctioned or already disbursed');
            }
            const loan = loanResult[0];

            // 3. Insert into standard 'vouchers' table
            // We store the loan case number in the remarks field as a searchable tag
            const voucherHeaderQuery = `
                INSERT INTO vouchers (
                    "id", "voucherNumber", "voucherDate", "voucherType", "totalAmount", 
                    "description", "memberId", "payeeName", "status", "remarks", "createdAt"
                ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
            `;

            // The voucher pays the sanctioned amount; a client amount may only be lower, never more than sanctioned (ES-319)
            const sanctioned = round2(parseFloat(loan.sanctioned_amt.toString().replace(/[^0-9.-]+/g, "")));
            let totalAmount = sanctioned;
            if (voucherData.actualAmount !== undefined && voucherData.actualAmount !== null && voucherData.actualAmount !== '') {
                const actual = Number(voucherData.actualAmount);
                if (!Number.isFinite(actual) || actual <= 0 || actual > sanctioned) {
                    throw new BadRequestException(`Voucher amount must be greater than 0 and not more than the sanctioned amount ${sanctioned}.`);
                }
                totalAmount = round2(actual);
            }
            if (Array.isArray(voucherData.breakdown) && voucherData.breakdown.length > 0) {
                const lines = voucherData.breakdown.map((e: any) => Number(e.amount));
                if (lines.some((a: number) => !Number.isFinite(a) || a < 0)) {
                    throw new BadRequestException('Every breakdown line needs an amount of 0 or more.');
                }
                // ES-507: the voucher total is the NET paid out. The loan itself is a Payment line; the share / RD
                // shortfall and other deductions are Receipt lines (rp 'Receipt' / 'R') and must be subtracted, not added.
                // Before, a loan of 10,000 with two 500 deductions was compared as 11,000 against the net 9,000 and refused.
                const isReceiptLine = (e: any) => /^r/i.test(String(e?.rp ?? e?.type ?? '').trim());
                const linesTotal = round2(voucherData.breakdown.reduce(
                    (sum: number, e: any) => sum + (isReceiptLine(e) ? -Number(e.amount) : Number(e.amount)), 0));
                if (linesTotal !== totalAmount) {
                    throw new BadRequestException(`The breakdown lines add up to ${linesTotal}, but the voucher total is ${totalAmount}.`);
                }
            }
            const nextId = await this.getNextId(queryRunner, 'vouchers');

            await queryRunner.query(voucherHeaderQuery, [
                nextId,
                voucherNumber,
                new Date(),
                'PAYMENT',
                totalAmount,
                `Loan disbursement for case ${voucherData.loanCaseNo}`,
                loan.mbno,
                voucherData.payeeName || loan.member_name || '', // Note: payeeName might needs join or passed
                'PENDING',
                `LOAN_CASE:${voucherData.loanCaseNo}|PAY_MODE:${voucherData.paymentMode}`,
                new Date()
            ]);

            // 4. Insert breakdown into 'transactions' table with pass_flag = 'N'
            if (voucherData.breakdown && Array.isArray(voucherData.breakdown)) {
                for (const entry of voucherData.breakdown) {
                    const transNo = await this.getNextId(queryRunner, 'transactions');
                    const transQuery = `
                        INSERT INTO transactions (
                            trans_no, trans_type, trans_date, mbno, trans_amt, 
                            receipt_vchr_no, vchr_type, modeofpay, pass_flag, cashier_flag,
                            narration, code, cheq_amt
                        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
                    `;

                    await queryRunner.query(transQuery, [
                        transNo,
                        'P', // Payment
                        new Date(),
                        loan.mbno,
                        entry.amount,
                        voucherNumber,
                        'LD', // Loan Disbursement
                        voucherData.paymentMode === 'CASH' ? 'C' : 'B',
                        'N', // pass_flag
                        'N', // cashier_flag
                        `${entry.name} [Code: ${entry.code}]`,
                        entry.code || null,
                        0 // cheq_amt default
                    ]);
                }
            }

            await queryRunner.commitTransaction();
            console.log(`[Voucher] ✅ Voucher ${voucherNumber} staged successfully in standard tables`);

            return {
                success: true,
                message: 'Voucher generated and staged successfully',
                voucherNo: voucherNumber
            };

        } catch (error: any) {
            await queryRunner.rollbackTransaction();
            console.error('[Voucher] ❌ Error generating voucher:', error);
            throw error instanceof HttpException ? error : new Error('Failed to generate voucher: ' + error.message);
        } finally {
            await queryRunner.release();
        }
    }

    /**
     * Helper to get next numeric ID for a table
     */
    private async getNextId(queryRunner: { query: (sql: string, params?: any[]) => Promise<any> }, tableName: string): Promise<number> {
        let idColumn = 'id';
        if (tableName === 'transactions') idColumn = 'trans_no';

        // On the voucher's own transaction, under a lock held until commit: two vouchers staged at the same
        // moment can not read the same MAX and get the same id (ES-413).
        await queryRunner.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`${tableName}.${idColumn}`]);
        const result = await queryRunner.query(`SELECT COALESCE(MAX(${idColumn}), 0) + 1 as next_id FROM ${tableName}`);
        return parseInt(result[0].next_id);
    }

    /**
     * Delete/Reject a pending voucher (only PENDING status)
     */
    async deleteVoucher(voucherNo: string) {
        const queryRunner = this.dataSource.createQueryRunner();

        try {
            await queryRunner.connect();
            await queryRunner.startTransaction();

            console.log(`[Voucher] 🗑️ Deleting pending voucher: ${voucherNo}`);

            // 1. Verify voucher exists and is PENDING
            const voucherResult = await queryRunner.query(
                `SELECT * FROM vouchers WHERE "voucherNumber" = $1`, [voucherNo]
            );

            if (voucherResult.length === 0) {
                throw new NotFoundException(`Voucher ${voucherNo} not found`);
            }

            if (voucherResult[0].status !== 'PENDING') {
                throw new BadRequestException(`Cannot delete voucher ${voucherNo} - status is ${voucherResult[0].status}. Only PENDING vouchers can be deleted.`);
            }

            if (voucherResult[0].sourceModule === 'LOAN_REAGREEMENT') {
                await this.reagreementService.onVoucherRejected(queryRunner, voucherNo, { actor: 'admin' });
            }

            // 2. Delete transaction rows linked to this voucher
            const deletedTrans = await queryRunner.query(
                `DELETE FROM transactions WHERE receipt_vchr_no = $1`, [voucherNo]
            );
            console.log(`[Voucher] Deleted ${deletedTrans[1] || 0} transaction rows for ${voucherNo}`);

            // 3. Delete the voucher header
            await queryRunner.query(
                `DELETE FROM vouchers WHERE "voucherNumber" = $1`, [voucherNo]
            );

            await queryRunner.commitTransaction();
            console.log(`[Voucher] ✅ Voucher ${voucherNo} deleted successfully`);

            return { success: true, message: `Voucher ${voucherNo} deleted successfully` };

        } catch (error: any) {
            await queryRunner.rollbackTransaction();
            console.error('[Voucher] ❌ Error deleting voucher:', error);
            throw error instanceof HttpException ? error : new Error('Failed to delete voucher: ' + error.message);
        } finally {
            await queryRunner.release();
        }
    }

    /**
     * Get pending vouchers ready for Pass Transaction
     */
    async getPendingVouchers() {
        try {
            const query = `
                SELECT 
                    v.*,
                    m.f_name, m.m_name, m.l_name
                FROM vouchers v
                LEFT JOIN member_master m ON v."memberId" = m.mbno
                WHERE v.status = 'PENDING'
                ORDER BY v."createdAt" DESC
            `;

            const result = await this.dataSource.query(query);

            const vouchersWithDetails = [];
            for (const row of result) {
                // Extract loan case no from remarks
                const remarksMatch = (row.remarks || '').match(/LOAN_CASE:([^|]+)/);
                const loanCaseNo = remarksMatch ? remarksMatch[1] : '';

                let loanType = 'GENERAL';
                if (loanCaseNo) {
                    const lp = await this.dataSource.query(`SELECT loantype FROM loan_pending WHERE loancaseno::text = $1`, [loanCaseNo]);
                    if (lp.length > 0) loanType = lp[0].loantype;
                }

                // Fetch details from transactions table
                const transQuery = `SELECT * FROM transactions WHERE receipt_vchr_no = $1 AND pass_flag = 'N'`;
                const trans = await this.dataSource.query(transQuery, [row.voucherNumber]);

                let reagreement: any = null;
                if (row.sourceModule === 'LOAN_REAGREEMENT' && row.sourceId) {
                    reagreement = await this.reagreementService.getById(row.sourceId).catch(() => null);
                }

                vouchersWithDetails.push({
                    id: row.id,
                    voucherNo: row.voucherNumber,
                    memberNo: row.memberId,
                    memberName: [row.f_name, row.m_name, row.l_name].map((n: any) => (n || '').toString().trim()).filter(Boolean).join(' '),
                    amount: parseFloat(row.totalAmount),
                    vchrType: reagreement ? 'Loan Re-agreement' : (row.voucherType || 'Loan Disbursement'),
                    loanType: reagreement ? reagreement.loantype : loanType,
                    kind: reagreement ? 'REAGREEMENT' : 'VOUCHER',
                    reagreement,
                    status: row.status,
                    narration: row.description,
                    loanCaseNo: reagreement ? reagreement.newLoanCaseNo : loanCaseNo,
                    paymentMode: row.bankName || row.chequeNumber ? 'bank' : 'cash',
                    chequeNo: row.chequeNumber,
                    chequeDate: row.chequeDate,
                    bankName: row.bankName,
                    createdDate: row.createdAt,
                    breakdown: trans.map((t: any, idx: number) => ({
                        srNo: (idx + 1).toString(),
                        code: t.code || '',
                        name: t.narration || t.particulars,
                        rp: (reagreement || String(row.voucherType || '').toUpperCase() === 'RECEIPT') ? 'R' : 'P',
                        amount: parseFloat(t.trans_amt)
                    }))
                });
            }

            return vouchersWithDetails;

        } catch (error: any) {
            console.error('[Voucher] ❌ Error fetching pending vouchers:', error);
            throw new Error('Failed to fetch pending vouchers: ' + error.message);
        }
    }

    async getVoucherDetails(voucherNo: string) {
        // Implement if needed for specific view, similar to getPendingVouchers item fetch
        const pending = await this.getPendingVouchers();
        return pending.find(v => v.voucherNo === voucherNo) || null;
    }
}
