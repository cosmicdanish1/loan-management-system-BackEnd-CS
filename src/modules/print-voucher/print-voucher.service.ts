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
        // BUG FIX: trans_type's DR/CR convention is inconsistent across the app's
        // 3 different voucher-creation paths (savePaymentVoucher writes 'P'/'R'
        // into trans_type, not 'DR'/'CR'; saveReceiptVoucher inserts its cash leg
        // — trans_type='DR' — as the FIRST row despite being a Receipt voucher).
        // Checking firstTrans.trans_type === 'DR' was live-confirmed to show a
        // real Payment Voucher as "Receipt". vchr_type is the one field every
        // creation path sets consistently on every row of a voucher regardless of
        // insertion order or that row's own DR/CR side ('R' = Receipt, everything
        // else — 'P'/'PV' — = Payment), so it's the reliable signal here.
        dto.dr_cr = firstTrans.vchr_type === 'R' ? 'Receipt' : 'Payment';
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

        // BUG FIX: entries/total_amount used to include every row, including the
        // balancing cash/bank leg — for a real ₹6,000 loan disbursement
        // (voucher P25888: one A1047 DR leg + one A1008 CR/cash leg, both
        // ₹6,000) this reported total_amount: 12000, double the real amount,
        // and rendered both legs under the same Payment/Receipt column.
        // Previously flagged as blocked on "no reliable way to identify the
        // cash leg" — acc_type is null on every row in this table (confirmed
        // live), so it can't be used. Since fixed, using the same rule
        // established for the Cash-Book reports this session: the literal
        // Cash-In-Hand head (A1001), or any real bank current account
        // (grouped under parent A1007) — both identifiable by head code
        // alone, which this table does populate.
        const bankCodesResult = await this.transactionsRepository.query(
            `SELECT code FROM headmaster WHERE parent_code = 'A1007'`
        );
        const bankCodes = new Set<string>(bankCodesResult.map((r: any) => r.code));
        const isCashLeg = (code: string) => code === 'A1001' || code === 'A1007' || bankCodes.has(code);

        dto.entries = [];
        let total = 0;

        for (const trans of transactions) {
            if (isCashLeg(trans.code)) continue;

            const entryDto = new VoucherPrintEntryDto();
            entryDto.trans_no = trans.trans_no;
            entryDto.head_code = trans.code;
            entryDto.amount = Number(trans.trans_amt);
            entryDto.narration = trans.narration;
            entryDto.mbno = trans.mbno;

            // BUG FIX: accountbalance is empty in this database (0 rows, confirmed
            // live) — this always fell straight through to trans.code, so the
            // voucher displayed the raw code ("A1047") instead of a real name.
            // headmaster has 151 real rows (confirmed live) and is the fallback
            // already established for the same gap in Member Ledger Report /
            // General Ledger this session.
            const headResult = await this.transactionsRepository.query(
                `SELECT acname FROM accountbalance WHERE acno = $1 LIMIT 1`,
                [trans.code]
            );
            let headName = headResult[0]?.acname;
            if (!headName) {
                const hmResult = await this.transactionsRepository.query(
                    `SELECT head_name FROM headmaster WHERE code = $1 LIMIT 1`,
                    [trans.code]
                );
                headName = hmResult[0]?.head_name;
            }
            entryDto.head_name = headName || trans.code || 'Unknown Head';

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
        // accountbalance gives proper head names, member_master gives member names.
        // BUG FIX: accountbalance is empty in this database (0 rows, confirmed
        // live) — ab.acname was always NULL, so head_name always fell through
        // to the raw code. headmaster has 151 real rows (confirmed live); added
        // as a second fallback join, same pattern already used to fix this exact
        // gap in Member Ledger Report / General Ledger this session.
        const rows = await this.ledgerRepository.query(`
            SELECT DISTINCT ON (l.ledgerid)
                l.ledgerid,
                l.trans_no,
                l.trans_date,
                l.narration,
                l.code                                                       AS head_code,
                COALESCE(ab.acname, hm.head_name, l.code)                    AS head_name,
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
            LEFT JOIN headmaster      hm ON hm.code = l.code
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
