import { Entity, Column, PrimaryColumn } from 'typeorm';

@Entity('ledger')
export class Ledger {
  @PrimaryColumn({ name: 'trans_no', type: 'numeric', precision: 18, scale: 0 })
  transactionNumber: string;

  // BUG FIX 53: ledgerid is NOT NULL with no default/sequence (confirmed via
  // information_schema) and wasn't mapped here at all — every manager.save(Ledger, ...)
  // in this module was missing a required column and would fail outright. Callers
  // must now generate and supply this explicitly (see InterestService.getNextId).
  @Column({ name: 'ledgerid', type: 'numeric', precision: 18, scale: 0 })
  ledgerId: number;

  @Column({ name: 'trans_date', type: 'timestamp' })
  transactionDate: Date;

  @Column({ name: 'trans_type', type: 'varchar', length: 2 })
  transactionType: string;

  @Column({ name: 'code', type: 'varchar', length: 5 })
  code: string;

  @Column({ name: 'mbno', type: 'numeric', precision: 18, scale: 0 })
  memberNumber: string;

  @Column({ name: 'acc_no', type: 'numeric', precision: 18, scale: 0 })
  accountNumber: string;

  @Column({ name: 'acc_type', type: 'varchar', length: 4 })
  accountType: string;

  @Column({ name: 'trans_amt', type: 'numeric', precision: 19, scale: 4, default: 0 })
  transactionAmount: number;

  @Column({ name: 'receipt_vchr_no', type: 'varchar', length: 6, default: '' })
  receiptVoucherNumber: string;

  @Column({ name: 'vchr_type', type: 'varchar', length: 2, default: '' })
  voucherType: string;

  @Column({ name: 'modeofpay', type: 'varchar', length: 1, default: '' })
  modeOfPayment: string;

  @Column({ name: 'pl_balance', type: 'numeric', precision: 19, scale: 4, default: 0 })
  balance: number;

  @Column({ name: 'narration', type: 'varchar', length: 100, default: '' })
  narration: string;

  @Column({ name: 'username', type: 'varchar', length: 50, default: '' })
  username: string;

  @Column({ name: 'cust_bank_name', type: 'varchar', length: 100, nullable: true })
  customerBankName: string;
}