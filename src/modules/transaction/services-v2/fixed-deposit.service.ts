import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';

@Injectable()
export class FixedDepositService {
    constructor(private readonly dataSource: DataSource) { }

    async createFixedDeposit(data: any) {
        const queryRunner = this.dataSource.createQueryRunner();
        await queryRunner.connect();
        await queryRunner.startTransaction();

        try {
            // 1. Insert into fdmaster
            // Mapping frontend fields to database columns based on SCHEMA
            /*
            "mbno" numeric,
            "account_number" numeric, -- Auto-generate or lookup?
            "prefix" varchar(5),
            "f_name" varchar(50),
            "m_name" varchar(50),
            "l_name" varchar(50),
            "certno" varchar(10),
            "depunit" int4 NOT NULL, -- Enum or Int?
            "depperiod" numeric,
            "rate" numeric,
            "depdate" timestamp NOT NULL,
            "matdate" timestamp,
            "fdamount" numeric,
            "matamount" numeric,
            "interestpayamentmode" int4, -- 1=Monthly, etc?
            "interestamount" numeric,
            "nominee" varchar(80),
            "nage" varchar(6),
            "naddr" varchar(100),
            "nrelation" varchar(25),
            "fdrdflag" varchar(1), -- 'F' for FD?
            "status" varchar(1), -- 'A' for Active?
            "openbal" numeric
            */

            const accountNumber = await this.generateAccountNumber('FD');

            const insertQuery = `
                INSERT INTO fdmaster (
                    mbno, account_number, prefix, f_name, m_name, l_name,
                    certno, depunit, depperiod, rate, depdate, matdate,
                    fdamount, matamount, interestamount,
                    nominee, nage, naddr, nrelation,
                    fdrdflag, status, openbal, intcalmethod
                ) VALUES (
                    $1, $2, $3, $4, $5, $6,
                    $7, $8, $9, $10, $11, $12,
                    $13, $14, $15,
                    $16, $17, $18, $19,
                    'F', 'A', $20, $21
                )
            `;

            // Handle date formatting
            const depDate = data.depositDate ? new Date(data.depositDate) : new Date();
            const matDate = data.maturityDate ? new Date(data.maturityDate) : new Date();

            await queryRunner.query(insertQuery, [
                data.memberNo,
                accountNumber,
                data.prefix,
                data.firstName,
                data.middleName || '',
                data.lastName,
                data.certificateNo,
                data.depositUnit === 'Months' ? 1 : 2, // Assumption: 1=Months, 2=Years
                data.depositPeriod,
                data.rate,
                depDate,
                matDate,
                data.depositAmount,
                data.maturityAmount,
                data.intAmount || 0,
                data.nomineeName,
                data.nomineeAge,
                data.nomineeAddress,
                data.nomineeRelation,
                data.depositAmount, // Open balance = deposit amount
                data.intCalculationMethod === 'compound' ? 2 : 1 // Assumption
            ]);

            // 2. Create Voucher/Transaction (Optional but recommended for accounting)
            // For now, we'll focus on the primary task of storing RD/FD details.

            await queryRunner.commitTransaction();

            return {
                success: true,
                message: 'Fixed Deposit created successfully',
                accountNumber
            };

        } catch (error) {
            await queryRunner.rollbackTransaction();
            console.error('Error creating FD:', error);
            throw error;
        } finally {
            await queryRunner.release();
        }
    }

    async getActiveFDsByMember(memberNo: string) {
        const query = `
            SELECT 
                certno as "certNo",
                account_number as "acNo",
                fdamount as "amount",
                rate,
                lastintpaydate as "lastPayDate",
                interestamount as "interest",
                depdate as "depositDate",
                matdate as "maturityDate",
                depunit as "depositUnit",
                depperiod as "depPer",
                matamount as "maturityAmount",
                intpaid as "interestPaid",
                interestpayamentmode as "intPaymentMode",
                status
            FROM fdmaster 
            WHERE mbno = $1 AND status = 'A' AND fdrdflag = 'F'
        `;
        const result = await this.dataSource.query(query, [memberNo]);
        return result;
    }

    async createInterestVoucher(data: any) {
        const queryRunner = this.dataSource.createQueryRunner();
        await queryRunner.connect();
        await queryRunner.startTransaction();

        try {
            // INSERT into vouchers
            const query = `
                INSERT INTO vouchers (
                    "voucherNumber", "voucherDate", "voucherType", "totalAmount", 
                    "description", "memberId", "status", "authorizedAt"
                ) VALUES ($1, $2, $3, $4, $5, $6, 'PENDING', NOW())
                RETURNING id
            `;

            const voucherRes = await queryRunner.query(query, [
                data.voucherNo || `INT-${Date.now()}`,
                new Date(data.transDate),
                data.fdOption === 'interest' ? 'FD_INT' : 'FD_PAY',
                data.totalAmount,
                data.narration,
                data.memberNo
            ]);

            // Update fdmaster if needed (e.g. updating interest paid)
            if (data.certNo && data.calculatedIntt) {
                await queryRunner.query(`
                    UPDATE fdmaster 
                    SET lastintpaydate = $1, intpaid = COALESCE(intpaid, 0) + $2
                    WHERE certno = $3 AND mbno = $4
                 `, [new Date(), parseFloat(data.calculatedIntt), data.certNo, data.memberNo]);
            }

            await queryRunner.commitTransaction();
            return { success: true, voucherId: voucherRes[0].id };
        } catch (err) {
            await queryRunner.rollbackTransaction();
            throw err;
        } finally {
            await queryRunner.release();
        }
    }

    async closeFixedDeposit(data: any) {
        const queryRunner = this.dataSource.createQueryRunner();
        await queryRunner.connect();
        await queryRunner.startTransaction();

        try {
            // 1. Update FD Master status to Closed
            const closeQuery = `
                UPDATE fdmaster 
                SET status = 'C', 
                    statusdate = NOW(), 
                    matamount = $1, 
                    intpaid = COALESCE(intpaid, 0) + $2,
                    remarks = $3
                WHERE certno = $4 AND mbno = $5
            `;

            // Assume data.totalAmount includes principal + interest for final settlement? 
            // Or usually we track them separately. 
            // For now, let's assume totalAmount is the payout amount.

            await queryRunner.query(closeQuery, [
                data.maturityAmount,
                data.interestPaid || 0,
                'Closed/Withdrawn',
                data.certNo,
                data.memberNo
            ]);

            // 2. Create Voucher
            const query = `
                INSERT INTO vouchers (
                    "voucherNumber", "voucherDate", "voucherType", "totalAmount", 
                    "description", "memberId", "status", "authorizedAt", "payeeName", "bankName", "chequeNumber", "chequeDate"
                ) VALUES ($1, $2, 'FD_CLOSE', $3, $4, $5, 'PENDING', NOW(), $6, $7, $8, $9)
                RETURNING id
            `;

            const voucherRes = await queryRunner.query(query, [
                data.voucherNo || `CLS-${Date.now()}`,
                new Date(data.transDate || new Date()),
                data.totalAmount, // Principal + Interest
                data.narration || `FD Closure for Cert ${data.certNo}`,
                data.memberNo,
                data.payeeName || '',
                data.bankName || '',
                data.chequeNo || '',
                data.chequeDate ? new Date(data.chequeDate) : null
            ]);

            await queryRunner.commitTransaction();
            return { success: true, voucherId: voucherRes[0].id };

        } catch (err) {
            await queryRunner.rollbackTransaction();
            throw err;
        } finally {
            await queryRunner.release();
        }
    }
    private async generateAccountNumber(type: string): Promise<number> {
        // Simple mock generation or fetching max + 1
        const res = await this.dataSource.query('SELECT MAX(account_number) as max_acc FROM fdmaster');
        const max = parseInt(res[0].max_acc) || 10000;
        return max + 1;
    }
}
