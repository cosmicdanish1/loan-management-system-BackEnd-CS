import { Injectable, Logger } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { isDebitNormal } from '../../shared/utils/balance-direction';
import { generateVoucherNo } from '../../shared/utils/voucher-utils';

export interface TransferEntry {
    srNo: number;
    mbno: string;
    name: string;
    dbHeadBal: number;
    crHeadBal: number;
    dbAmt: number;
    crAmt: number;
    exCrAmt: number;
}

export interface GenerateResult {
    entries: TransferEntry[];
    totalDebit: number;
    totalCredit: number;
    excCredit: number;
}

@Injectable()
export class MemberBalanceTransferService {
    private readonly logger = new Logger(MemberBalanceTransferService.name);

    constructor(private readonly dataSource: DataSource) {}

    async generate(
        debitHead: string,
        creditHead: string,
        creditLimit: number,
        excessHead: string,
        balanceAsOn: string,
    ): Promise<GenerateResult> {
        this.logger.log(`Generating member balance transfer: DR=${debitHead} CR=${creditHead} limit=${creditLimit}`);

        const dbPflag = await this.dataSource.query(
            `SELECT pflag FROM headmaster WHERE code = $1 LIMIT 1`, [debitHead]
        );
        const crPflag = await this.dataSource.query(
            `SELECT pflag FROM headmaster WHERE code = $1 LIMIT 1`, [creditHead]
        );
        const dbDebitNormal = isDebitNormal(dbPflag[0]?.pflag);
        const crDebitNormal = isDebitNormal(crPflag[0]?.pflag);

        const members = await this.dataSource.query(`
            SELECT f.mbno::text as mbno,
                   TRIM(COALESCE(m.f_name,'') || ' ' || COALESCE(m.m_name,'') || ' ' || COALESCE(m.l_name,'')) as name
            FROM fundsmaster f
            JOIN member_master m ON m.mbno = f.mbno
            WHERE m.isactive = 'Y' OR m.isactive IS NULL
            ORDER BY f.mbno
        `);

        const entries: TransferEntry[] = [];
        let totalDebit = 0;
        let totalCredit = 0;
        let excCredit = 0;

        for (let i = 0; i < members.length; i++) {
            const mbno = members[i].mbno;

            const dbBalResult = await this.dataSource.query(`
                SELECT COALESCE(SUM(CASE WHEN trans_type='DR' THEN trans_amt::numeric ELSE 0 END), 0) as dr,
                       COALESCE(SUM(CASE WHEN trans_type='CR' THEN trans_amt::numeric ELSE 0 END), 0) as cr
                FROM ledger WHERE code = $1 AND mbno::text = $2 AND trans_date::date <= $3::date
            `, [debitHead, mbno, balanceAsOn]);

            const crBalResult = await this.dataSource.query(`
                SELECT COALESCE(SUM(CASE WHEN trans_type='DR' THEN trans_amt::numeric ELSE 0 END), 0) as dr,
                       COALESCE(SUM(CASE WHEN trans_type='CR' THEN trans_amt::numeric ELSE 0 END), 0) as cr
                FROM ledger WHERE code = $1 AND mbno::text = $2 AND trans_date::date <= $3::date
            `, [creditHead, mbno, balanceAsOn]);

            const dbDr = parseFloat(dbBalResult[0]?.dr) || 0;
            const dbCr = parseFloat(dbBalResult[0]?.cr) || 0;
            const crDr = parseFloat(crBalResult[0]?.dr) || 0;
            const crCr = parseFloat(crBalResult[0]?.cr) || 0;

            const dbHeadBal = dbDebitNormal ? (dbDr - dbCr) : (dbCr - dbDr);
            const crHeadBal = crDebitNormal ? (crDr - crCr) : (crCr - crDr);

            if (Math.abs(dbHeadBal) < 0.01) continue;

            const transferAmt = Math.round(Math.abs(dbHeadBal) * 100) / 100;
            const crAmt = Math.min(transferAmt, creditLimit);
            const exCrAmt = Math.round((transferAmt - crAmt) * 100) / 100;

            entries.push({
                srNo: entries.length + 1,
                mbno,
                name: members[i].name?.trim() || '',
                dbHeadBal: Math.round(dbHeadBal * 100) / 100,
                crHeadBal: Math.round(crHeadBal * 100) / 100,
                dbAmt: transferAmt,
                crAmt,
                exCrAmt: exCrAmt > 0 ? exCrAmt : 0,
            });

            totalDebit += transferAmt;
            totalCredit += crAmt;
            excCredit += exCrAmt > 0 ? exCrAmt : 0;
        }

        this.logger.log(`Generated ${entries.length} transfer entries. Total DR=${totalDebit} CR=${totalCredit} Exc=${excCredit}`);

        return {
            entries,
            totalDebit: Math.round(totalDebit * 100) / 100,
            totalCredit: Math.round(totalCredit * 100) / 100,
            excCredit: Math.round(excCredit * 100) / 100,
        };
    }

    async post(
        entries: TransferEntry[],
        debitHead: string,
        creditHead: string,
        excessHead: string,
        postedBy: string = 'admin',
    ): Promise<{ success: boolean; message: string; voucherNo: string }> {
        const queryRunner = this.dataSource.createQueryRunner();
        await queryRunner.connect();
        await queryRunner.startTransaction();

        try {
            const voucherNo = await generateVoucherNo(queryRunner, 'J');

            const maxLedgerResult = await queryRunner.query(`SELECT COALESCE(MAX(ledgerid), 0) as max_id FROM ledger`);
            let nextLedgerId = parseInt(maxLedgerResult[0].max_id) + 1;
            const maxTransResult = await queryRunner.query(`SELECT COALESCE(MAX(trans_no), 0) as max_no FROM ledger`);
            let nextTransNo = parseInt(maxTransResult[0].max_no) + 1;

            let posted = 0;

            for (const entry of entries) {
                if (entry.dbAmt <= 0) continue;

                // DR debit head (take from source)
                await queryRunner.query(`
                    INSERT INTO ledger (trans_no, trans_date, trans_type, code, mbno, acc_no, acc_type,
                        trans_amt, receipt_vchr_no, vchr_type, modeofpay, pl_balance, narration, username, ledgerid)
                    VALUES ($1, NOW(), 'DR', $2, $3, 0, 'OTH', $4, $5, 'J', 'T', 0, $6, $7, $8)
                `, [nextTransNo++, debitHead, entry.mbno, entry.dbAmt, voucherNo,
                    `Balance Transfer: ${debitHead} → ${creditHead}`, postedBy, nextLedgerId++]);

                // CR credit head (put into destination, up to limit)
                if (entry.crAmt > 0) {
                    await queryRunner.query(`
                        INSERT INTO ledger (trans_no, trans_date, trans_type, code, mbno, acc_no, acc_type,
                            trans_amt, receipt_vchr_no, vchr_type, modeofpay, pl_balance, narration, username, ledgerid)
                        VALUES ($1, NOW(), 'CR', $2, $3, 0, 'OTH', $4, $5, 'J', 'T', 0, $6, $7, $8)
                    `, [nextTransNo++, creditHead, entry.mbno, entry.crAmt, voucherNo,
                        `Balance Transfer: ${debitHead} → ${creditHead}`, postedBy, nextLedgerId++]);
                }

                // CR excess head (overflow beyond credit limit)
                if (entry.exCrAmt > 0 && excessHead) {
                    await queryRunner.query(`
                        INSERT INTO ledger (trans_no, trans_date, trans_type, code, mbno, acc_no, acc_type,
                            trans_amt, receipt_vchr_no, vchr_type, modeofpay, pl_balance, narration, username, ledgerid)
                        VALUES ($1, NOW(), 'CR', $2, $3, 0, 'OTH', $4, $5, 'J', 'T', 0, $6, $7, $8)
                    `, [nextTransNo++, excessHead, entry.mbno, entry.exCrAmt, voucherNo,
                        `Balance Transfer Excess: ${debitHead} → ${excessHead}`, postedBy, nextLedgerId++]);
                }

                // Cashbook entries
                await queryRunner.query(`
                    INSERT INTO tblcashbook (headcode, headname, rcash, rtransfer, pcash, ptransfer, trans_date)
                    VALUES ($1, $2, 0, 0, 0, $3, NOW())
                `, [debitHead, `Transfer DR ${debitHead}`, entry.dbAmt]);

                await queryRunner.query(`
                    INSERT INTO tblcashbook (headcode, headname, rcash, rtransfer, pcash, ptransfer, trans_date)
                    VALUES ($1, $2, 0, $3, 0, 0, NOW())
                `, [creditHead, `Transfer CR ${creditHead}`, entry.crAmt]);

                posted++;
            }

            await queryRunner.commitTransaction();
            this.logger.log(`Posted ${posted} member balance transfers. Voucher: ${voucherNo}`);

            return {
                success: true,
                message: `${posted} member transfers posted successfully. Voucher: ${voucherNo}`,
                voucherNo,
            };
        } catch (error: any) {
            await queryRunner.rollbackTransaction();
            this.logger.error('Member balance transfer post failed:', error);
            throw new Error('Failed to post member balance transfer: ' + error.message);
        } finally {
            await queryRunner.release();
        }
    }
}
