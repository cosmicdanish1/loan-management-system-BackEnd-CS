import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Transactions } from './entities/transactions.entity';
import { HeadMaster } from './entities/head-master.entity';
import { MemberMaster } from '@modules/member/entities/member-master.entity';
import { Ledger } from './entities/ledger.entity';
import { JournalVoucherDto, JournalEntryDto } from './dto/journal-voucher.dto';
import { VoucherPrintDto } from './dto/print-voucher.dto';

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

    async getVoucherByNo(voucherNo: string): Promise<VoucherPrintDto> {
        const transaction = await this.transactionsRepository.findOne({
            where: { receipt_vchr_no: voucherNo },
        });

        if (!transaction) {
            throw new NotFoundException(`Voucher ${voucherNo} not found`);
        }

        const member = await this.memberMasterRepository.findOne({
            where: { mbno: transaction.mbno.toString() },
        });

        const head = await this.headMasterRepository.findOne({
            where: { code: transaction.code },
        });

        const dto = new VoucherPrintDto();
        dto.voucher_no = transaction.receipt_vchr_no;
        dto.trans_date = transaction.trans_date;
        dto.amount = transaction.trans_amt;
        dto.narration = transaction.narration;
        dto.dr_cr = transaction.trans_type === 'DR' ? 'Payment' : 'Receipt';

        dto.mode = transaction.modeofpay === 'C' ? 'Cheque' : 'Cash'; // Adjust mapping as needed
        if (transaction.modeofpay === 'B') dto.mode = 'Bank Transfer';

        dto.cheque_no = transaction.cheq_no;
        dto.cheque_date = transaction.cheq_date;
        dto.bank_name = transaction.bankname;

        dto.member_no = transaction.mbno;
        dto.member_name = member ? member.fullName : 'Unknown Member';

        dto.head_code = transaction.code;
        dto.head_name = head ? head.head_name : 'Unknown Head';

        return dto;
    }

    async getAllVoucherNos(): Promise<string[]> {
        const transactions = await this.transactionsRepository
            .createQueryBuilder('transaction')
            .select('DISTINCT transaction.receipt_vchr_no', 'voucher_no')
            .where("transaction.receipt_vchr_no != ''")
            .orderBy('voucher_no', 'DESC')
            .getRawMany();

        return transactions.map(t => t.voucher_no);
    }

    async getAllJournalVoucherNos(): Promise<string[]> {
        const ledgers = await this.ledgerRepository
            .createQueryBuilder('ledger')
            .select('DISTINCT ledger.receipt_vchr_no', 'voucher_no')
            .where("ledger.receipt_vchr_no != ''")
            .orderBy('voucher_no', 'DESC')
            .getRawMany();

        return ledgers.map(l => l.voucher_no);
    }

    async getJournalVoucherByNo(voucherNo: string): Promise<JournalVoucherDto> {
        const entries = await this.ledgerRepository.find({
            where: { receipt_vchr_no: voucherNo },
            order: { trans_no: 'ASC' }
        });

        if (!entries || entries.length === 0) {
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
            entryDto.member_code = entry.mbno;
            entryDto.head_code = entry.code;
            // Parse money string (e.g., "₹ 25,000.00" -> 25000)
            const parseMoneyString = (moneyStr: any): number => {
                if (!moneyStr) return 0;
                const str = moneyStr.toString();
                console.log(`Parsing money string: "${str}"`); // Debug log
                // Remove currency symbols, spaces, and commas, then parse
                const cleanStr = str.replace(/[₹$,\s]/g, '');
                const result = parseFloat(cleanStr) || 0;
                console.log(`Parsed result: ${result}`); // Debug log
                return result;
            };

            entryDto.debit = entry.trans_type === 'DR' ? parseMoneyString(entry.trans_amt) : 0;
            entryDto.credit = entry.trans_type === 'CR' ? parseMoneyString(entry.trans_amt) : 0;

            // Fetch Member Name
            const member = await this.memberMasterRepository.findOne({
                where: { mbno: entry.mbno.toString() }
            });
            entryDto.member_name = member ? member.fullName : `Member ${entry.mbno}`;

            // Fetch Head Name
            const head = await this.headMasterRepository.findOne({
                where: { code: entry.code }
            });
            entryDto.head_name = head ? head.head_name : `Head ${entry.code}`;

            dto.entries.push(entryDto);
        }

        return dto;
    }
}
