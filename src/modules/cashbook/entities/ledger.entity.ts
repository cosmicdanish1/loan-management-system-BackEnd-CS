import { Entity, Column, PrimaryColumn } from 'typeorm';

@Entity('ledger')
export class Ledger {
  @PrimaryColumn({ name: 'trans_no', type: 'numeric', precision: 18, scale: 0 })
  trans_no: number;

  @PrimaryColumn({ name: 'trans_date', type: 'timestamp' })
  trans_date: Date;

  @PrimaryColumn({ name: 'code', type: 'varchar', length: 5 })
  code: string;

  @PrimaryColumn({ name: 'mbno', type: 'numeric', precision: 18, scale: 0 })
  mbno: number;

  @Column({ name: 'trans_type', type: 'varchar', length: 2 })
  trans_type: string;

  @Column({ name: 'acc_no', type: 'numeric', precision: 18, scale: 0 })
  acc_no: number;

  @Column({ name: 'acc_type', type: 'varchar', length: 4 })
  acc_type: string;

  @Column({ name: 'trans_amt', type: 'numeric', precision: 19, scale: 4, default: 0 })
  trans_amt: number;

  @Column({ name: 'receipt_vchr_no', type: 'varchar', length: 6, default: '' })
  receipt_vchr_no: string;

  @Column({ name: 'vchr_type', type: 'varchar', length: 2, default: '' })
  vchr_type: string;

  @Column({ name: 'modeofpay', type: 'varchar', length: 1, default: '' })
  modeofpay: string;

  @Column({ name: 'pl_balance', type: 'numeric', precision: 19, scale: 4, default: 0 })
  pl_balance: number;

  @Column({ name: 'narration', type: 'varchar', length: 100, default: '' })
  narration: string;

  @Column({ name: 'username', type: 'varchar', length: 50, default: '' })
  username: string;

  @Column({ name: 'cust_bank_name', type: 'varchar', length: 100, nullable: true })
  cust_bank_name: string;
}