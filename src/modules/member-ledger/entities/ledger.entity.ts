import { Entity, Column, PrimaryColumn } from 'typeorm';

@Entity('ledger')
export class Ledger {
  @PrimaryColumn({ type: 'numeric', precision: 18, scale: 0 })
  trans_no: number;

  @Column({ type: 'timestamp' })
  trans_date: Date;

  @Column({ type: 'varchar', length: 2 })
  trans_type: string;

  @Column({ type: 'varchar', length: 5 })
  code: string;

  @Column({ type: 'numeric', precision: 18, scale: 0 })
  mbno: number;

  @Column({ type: 'numeric', precision: 18, scale: 0 })
  acc_no: number;

  @Column({ type: 'varchar', length: 4 })
  acc_type: string;

  @Column({ type: 'numeric', precision: 19, scale: 4, default: 0 })
  trans_amt: number;

  @Column({ type: 'varchar', length: 6, default: '' })
  receipt_vchr_no: string;

  @Column({ type: 'varchar', length: 2, default: '' })
  vchr_type: string;

  @Column({ type: 'varchar', length: 1, default: '' })
  modeofpay: string;

  @Column({ type: 'numeric', precision: 19, scale: 4, default: 0 })
  pl_balance: number;

  @Column({ type: 'varchar', length: 100, default: '' })
  narration: string;

  @Column({ type: 'varchar', length: 50, default: '' })
  username: string;

  @Column({ type: 'varchar', length: 100, nullable: true })
  cust_bank_name: string;
}