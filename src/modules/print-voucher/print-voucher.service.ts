import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Transactions } from './entities/transactions.entity';
import { HeadMaster } from './entities/head-master.entity';
import { MemberMaster } from '@modules/member/entities/member-master.entity';
import { Ledger } from './entities/ledger.entity';
import { JournalVoucherDto, JournalEntryDto } from './dto/journal-voucher.dto';
import { VoucherPrintDto, VoucherPrintEntryDto } from './dto/print-voucher.dto';

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
        const transactions = await this.transactionsRepository.find({
            where: { receipt_vchr_no: voucherNo },
            order: { trans_no: 'ASC' }
        });

        if (!transactions || transactions.length === 0) {
            throw new NotFoundException(`Voucher ${voucherNo} not found`);
        }

        const firstTrans = transactions[0];

        const dto = new VoucherPrintDto();
        dto.voucher_no = voucherNo;
        dto.trans_date = firstTrans.trans_date;
        dto.narration = firstTrans.narration;
        dto.dr_cr = firstTrans.trans_type === 'DR' ? 'Payment' : 'Receipt';
        dto.mode = firstTrans.modeofpay === 'C' ? 'Cash' : (firstTrans.modeofpay === 'Q' ? 'Cheque' : 'Bank');
        if (firstTrans.modeofpay === 'B') dto.mode = 'Bank Transfer';

        dto.cheque_no = firstTrans.cheq_no;
        dto.cheque_date = firstTrans.cheq_date;
        dto.bank_name = firstTrans.bankname;

        // Fetch member name for the first transaction
        if (firstTrans.mbno) {
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
            entryDto.amount = Number(trans.trans_amt);
            entryDto.narration = trans.narration;
            entryDto.mbno = trans.mbno;

            // Use accountbalance for proper head names (headmaster only has 20 generic rows)
            const headResult = await this.transactionsRepository.query(
                `SELECT acname FROM accountbalance WHERE acno = $1 LIMIT 1`,
                [trans.code]
            );
            entryDto.head_name = headResult[0]?.acname || trans.code || 'Unknown Head';

            dto.entries.push(entryDto);
            total += entryDto.amount;
        }

        dto.total_amount = total;

        return dto;
    }

    async getAllVoucherNos(): Promise<string[]> {
        const rows = await this.transactionsRepository.query(`
            SELECT DISTINCT receipt_vchr_no AS voucher_no
            FROM transactions
            WHERE receipt_vchr_no IS NOT NULL AND TRIM(receipt_vchr_no) != ''
            ORDER BY voucher_no DESC
        `);
        return rows.map((r: any) => r.voucher_no);
    }

    async getAllJournalVoucherNos(): Promise<string[]> {
        const rows = await this.ledgerRepository.query(`
            SELECT DISTINCT receipt_vchr_no AS voucher_no
            FROM ledger
            WHERE receipt_vchr_no IS NOT NULL AND TRIM(receipt_vchr_no) != ''
            ORDER BY voucher_no DESC
        `);
        return rows.map((r: any) => r.voucher_no);
    }

    async getJournalVoucherByNo(voucherNo: string): Promise<JournalVoucherDto> {
        // Single JOIN query — DISTINCT ON deduplicates old duplicate ledger rows,
        // accountbalance gives proper head names, member_master gives member names
        const rows = await this.ledgerRepository.query(`
            SELECT DISTINCT ON (l.ledgerid)
                l.ledgerid,
                l.trans_no,
                l.trans_date,
                l.narration,
                l.code                                                       AS head_code,
                COALESCE(ab.acname, l.code)                                  AS head_name,
                l.trans_type,
                CAST(l.trans_amt AS numeric)                                 AS amount,
                CAST(l.mbno AS text)                                         AS mb_no,
                TRIM(
                    COALESCE(m.f_name,'') || ' ' ||
                    COALESCE(m.m_name,'') || ' ' ||
                    COALESCE(m.l_name,'')
                )                                                            AS member_name
            FROM ledger l
            LEFT JOIN accountbalance  ab ON ab.acno = l.code
            LEFT JOIN member_master   m  ON CAST(m.mbno AS text) = CAST(l.mbno AS text)
            WHERE l.receipt_vchr_no = $1
            ORDER BY l.ledgerid
        `, [voucherNo]);

        if (!rows || rows.length === 0) {
            throw new NotFoundException(`Journal Voucher ${voucherNo} not found`);
        }

        const dto = new JournalVoucherDto();
        dto.voucher_no = voucherNo;
        dto.trans_date = rows[0].trans_date;
        dto.narration  = rows[0].narration;
        dto.entries    = rows.map((r: any) => {
            const amt = parseFloat(r.amount) || 0;
            const entryDto       = new JournalEntryDto();
            entryDto.trans_no    = r.trans_no;
            entryDto.member_code = r.mb_no;
            entryDto.member_name = r.member_name?.trim() || r.mb_no || '';
            entryDto.head_code   = r.head_code;
            entryDto.head_name   = r.head_name;
            entryDto.debit       = r.trans_type === 'DR' ? amt : 0;
            entryDto.credit      = r.trans_type === 'CR' ? amt : 0;
            return entryDto;
        });

        return dto;
    }
}
