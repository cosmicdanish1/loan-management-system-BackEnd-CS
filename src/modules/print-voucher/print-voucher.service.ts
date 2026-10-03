import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Transactions } from './entities/transactions.entity';
import { HeadMaster } from './entities/head-master.entity';
import { MemberMaster } from '../member/entities/member-master.entity';
import { Ledger } from './entities/ledger.entity';
import { JournalVoucherDto, JournalEntryDto } from './dto/journal-voucher.dto';
import { VoucherPrintDto, VoucherPrintEntryDto } from './dto/print-voucher.dto';

export interface VoucherReference {
    voucher_no: string;
    voucher_date: string;
}

@Injectable()
export class PrintVoucherService {
    constructor(
        @InjectRepository(Transactions)
        private transactionsRepository: Repository<Transactions>,
        @InjectRepository(HeadMaster)
        private headMasterRepository: Repository<HeadMaster>,
        @InjectRepository(MemberMaster)
        private memberMasterRepository: Repository<MemberMaster>,
        @InjectRepository(Ledger)
        private ledgerRepository: Repository<Ledger>,
    ) { }

    private directionFor(type: string): 'Payment' | 'Receipt' {
        switch ((type || '').trim().toUpperCase()) {
            case 'P':
            case 'DR':
                return 'Payment';
            case 'R':
            case 'CR':
                return 'Receipt';
            default:
                throw new BadRequestException(`Unsupported voucher transaction type: ${type || '(empty)'}`);
        }
    }

    private amountFor(value: unknown): number {
        const amount = typeof value === 'number' ? value : Number(String(value ?? '').replace(/[₹$,\s]/g, ''));
        if (!Number.isFinite(amount)) {
            throw new BadRequestException('Voucher contains an invalid transaction amount');
        }
        return amount;
    }

    private validateVoucherDate(voucherDate?: string): void {
        if (voucherDate && !/^\d{4}-\d{2}-\d{2}$/.test(voucherDate)) {
            throw new BadRequestException('Voucher date must use YYYY-MM-DD format');
        }
    }

    private voucherDateString(value: Date | string): string {
        return value instanceof Date ? value.toISOString().slice(0, 10) : String(value).slice(0, 10);
    }

    async getVoucherByNo(voucherNo: string, voucherDate?: string): Promise<VoucherPrintDto> {
        this.validateVoucherDate(voucherDate);
        const query = this.transactionsRepository.createQueryBuilder('transaction')
            .where('transaction.receipt_vchr_no = :voucherNo', { voucherNo })
            .andWhere("COALESCE(transaction.vchr_type, '') NOT IN ('JV', 'J')");
        if (voucherDate) {
            query.andWhere("transaction.trans_date >= CAST(:voucherDate AS date) AND transaction.trans_date < CAST(:voucherDate AS date) + INTERVAL '1 day'", { voucherDate });
        }
        const transactions = await query.orderBy('transaction.trans_no', 'ASC').getMany();

        if (transactions.length === 0) {
            throw new NotFoundException(`Voucher ${voucherNo} not found`);
        }

        const firstTrans = transactions[0];
        const directions = new Set(transactions.map(trans => this.directionFor(trans.trans_type)));
        const dto = new VoucherPrintDto();
        dto.voucher_no = voucherNo;
        dto.trans_date = firstTrans.trans_date;
        dto.narration = firstTrans.narration;
        dto.dr_cr = directions.size === 1 ? [...directions][0] : 'Mixed';
        const modes: Record<string, string> = { C: 'Cash', Q: 'Cheque', B: 'Bank Transfer' };
        dto.mode = modes[(firstTrans.modeofpay || '').trim().toUpperCase()] || 'Other';
        dto.cheque_no = firstTrans.cheq_no;
        dto.cheque_date = firstTrans.cheq_date;
        dto.bank_name = firstTrans.bankname;

        if (firstTrans.mbno && Number(firstTrans.mbno) !== 0) {
            const member = await this.memberMasterRepository.findOne({
                where: { mbno: firstTrans.mbno.toString() },
            });
            dto.member_no = firstTrans.mbno;
            dto.member_name = member ? member.fullName : 'Unknown Member';
        }

        dto.entries = [];
        let total = 0;
        for (const trans of transactions) {
            const entryDto = new VoucherPrintEntryDto();
            entryDto.trans_no = trans.trans_no;
            entryDto.head_code = trans.code;
            entryDto.amount = this.amountFor(trans.trans_amt);
            entryDto.direction = this.directionFor(trans.trans_type);
            entryDto.narration = trans.narration;
            entryDto.mbno = trans.mbno && Number(trans.mbno) !== 0 ? trans.mbno : undefined;
            if (trans.mbno && Number(trans.mbno) !== 0) {
                const member = await this.memberMasterRepository.findOne({ where: { mbno: trans.mbno.toString() } });
                entryDto.member_name = member?.fullName || 'Unknown Member';
            } else {
                entryDto.member_name = '';
            }

            const head = await this.headMasterRepository.findOne({ where: { code: trans.code } });
            entryDto.head_name = head ? head.head_name : 'Unknown Head';
            dto.entries.push(entryDto);
            total += entryDto.amount;
        }
        dto.total_amount = total;
        return dto;
    }

    async getAllVoucherNos(): Promise<string[]> {
        const transactions = await this.transactionsRepository
            .createQueryBuilder('transaction')
            .select('DISTINCT transaction.receipt_vchr_no', 'voucher_no')
            .where("transaction.receipt_vchr_no != ''")
            .andWhere("COALESCE(transaction.vchr_type, '') NOT IN ('JV', 'J')")
            .orderBy('voucher_no', 'DESC')
            .getRawMany();

        return transactions.map(transaction => transaction.voucher_no);
    }

    async getAllVoucherReferences(): Promise<VoucherReference[]> {
        const rows = await this.transactionsRepository.createQueryBuilder('transaction')
            .select('transaction.receipt_vchr_no', 'voucher_no')
            .addSelect('CAST(transaction.trans_date AS date)', 'voucher_date')
            .where("transaction.receipt_vchr_no != ''")
            .andWhere("COALESCE(transaction.vchr_type, '') NOT IN ('JV', 'J')")
            .groupBy('transaction.receipt_vchr_no')
            .addGroupBy('CAST(transaction.trans_date AS date)')
            .orderBy('voucher_date', 'DESC')
            .addOrderBy('voucher_no', 'DESC')
            .getRawMany();
        return rows.map(row => ({ voucher_no: row.voucher_no, voucher_date: this.voucherDateString(row.voucher_date) }));
    }

    async getAllJournalVoucherNos(): Promise<string[]> {
        const [transactionVouchers, legacyVouchers] = await Promise.all([this.transactionsRepository
            .createQueryBuilder('transaction')
            .select('DISTINCT transaction.receipt_vchr_no', 'voucher_no')
            .where("transaction.receipt_vchr_no != ''")
            .andWhere("transaction.vchr_type IN ('JV', 'J')")
            .orderBy('voucher_no', 'DESC')
            .getRawMany(), this.ledgerRepository
            .createQueryBuilder('ledger')
            .select('DISTINCT ledger.receipt_vchr_no', 'voucher_no')
            .where("ledger.receipt_vchr_no != ''")
            .andWhere("ledger.vchr_type IN ('JV', 'J')")
            .orderBy('voucher_no', 'DESC')
            .getRawMany()]);

        return [...new Set([...transactionVouchers, ...legacyVouchers].map(voucher => voucher.voucher_no))]
            .sort((left, right) => right.localeCompare(left, undefined, { numeric: true }));
    }

    async getAllJournalVoucherReferences(): Promise<VoucherReference[]> {
        const [transactionRows, ledgerRows] = await Promise.all([
            this.transactionsRepository.createQueryBuilder('transaction')
                .select('transaction.receipt_vchr_no', 'voucher_no')
                .addSelect('CAST(transaction.trans_date AS date)', 'voucher_date')
                .where("transaction.receipt_vchr_no != ''")
                .andWhere("transaction.vchr_type IN ('JV', 'J')")
                .groupBy('transaction.receipt_vchr_no')
                .addGroupBy('CAST(transaction.trans_date AS date)')
                .getRawMany(),
            this.ledgerRepository.createQueryBuilder('ledger')
                .select('ledger.receipt_vchr_no', 'voucher_no')
                .addSelect('CAST(ledger.trans_date AS date)', 'voucher_date')
                .where("ledger.receipt_vchr_no != ''")
                .andWhere("ledger.vchr_type IN ('JV', 'J')")
                .groupBy('ledger.receipt_vchr_no')
                .addGroupBy('CAST(ledger.trans_date AS date)')
                .getRawMany(),
        ]);
        const byKey = new Map<string, VoucherReference>();
        for (const row of [...transactionRows, ...ledgerRows]) {
            const ref = { voucher_no: row.voucher_no, voucher_date: this.voucherDateString(row.voucher_date) };
            byKey.set(`${ref.voucher_no}|${ref.voucher_date}`, ref);
        }
        return [...byKey.values()].sort((left, right) =>
            right.voucher_date.localeCompare(left.voucher_date) || right.voucher_no.localeCompare(left.voucher_no, undefined, { numeric: true }));
    }

    async getJournalVoucherByNo(voucherNo: string, voucherDate?: string): Promise<JournalVoucherDto> {
        this.validateVoucherDate(voucherDate);
        // Journal posting persists every voucher leg to transactions; ledger only
        // receives member-linked legs, which would silently omit general-account rows.
        const transactionQuery = this.transactionsRepository.createQueryBuilder('transaction')
            .where('transaction.receipt_vchr_no = :voucherNo', { voucherNo })
            .andWhere("transaction.vchr_type IN ('JV', 'J')");
        if (voucherDate) {
            transactionQuery.andWhere("transaction.trans_date >= CAST(:voucherDate AS date) AND transaction.trans_date < CAST(:voucherDate AS date) + INTERVAL '1 day'", { voucherDate });
        }
        let entries = await transactionQuery.orderBy('transaction.trans_no', 'ASC').getMany();
        if (entries.length === 0) {
            const legacyQuery = this.ledgerRepository.createQueryBuilder('ledger')
                .where('ledger.receipt_vchr_no = :voucherNo', { voucherNo })
                .andWhere("ledger.vchr_type IN ('JV', 'J')");
            if (voucherDate) {
                legacyQuery.andWhere("ledger.trans_date >= CAST(:voucherDate AS date) AND ledger.trans_date < CAST(:voucherDate AS date) + INTERVAL '1 day'", { voucherDate });
            }
            const legacyEntries = await legacyQuery.orderBy('ledger.trans_no', 'ASC').getMany();
            entries = legacyEntries as unknown as Transactions[];
        }

        if (entries.length === 0) {
            throw new NotFoundException(`Journal Voucher ${voucherNo} not found`);
        }

        const dto = new JournalVoucherDto();
        dto.voucher_no = voucherNo;
        dto.trans_date = entries[0].trans_date;
        dto.narration = entries[0].narration;
        dto.entries = [];

        for (const entry of entries) {
            const entryDto = new JournalEntryDto();
            entryDto.trans_no = entry.trans_no;
            entryDto.member_code = entry.mbno && Number(entry.mbno) !== 0 ? entry.mbno : '';
            entryDto.head_code = entry.code;
            const amount = this.amountFor(entry.trans_amt);
            const direction = this.directionFor(entry.trans_type);
            entryDto.debit = direction === 'Payment' ? amount : 0;
            entryDto.credit = direction === 'Receipt' ? amount : 0;

            const member = entry.mbno && Number(entry.mbno) !== 0
                ? await this.memberMasterRepository.findOne({ where: { mbno: entry.mbno.toString() } })
                : null;
            entryDto.member_name = member ? member.fullName : '';

            const head = await this.headMasterRepository.findOne({ where: { code: entry.code } });
            entryDto.head_name = head ? head.head_name : `Head ${entry.code}`;
            dto.entries.push(entryDto);
        }

        return dto;
    }
}
