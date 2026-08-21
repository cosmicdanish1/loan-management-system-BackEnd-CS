import { Entity, Column, PrimaryColumn, ManyToOne, JoinColumn } from 'typeorm';
import { InterestMaster } from './interest-master.entity';

@Entity('interestpaid')
export class InterestPaid {
  @PrimaryColumn({ name: 'id', type: 'numeric', precision: 18, scale: 0 })
  id: string;

  @PrimaryColumn({ name: 'mbno', type: 'numeric', precision: 18, scale: 0 })
  mbno: string;

  @Column({ name: 'wrno', type: 'varchar', length: 20, default: '' })
  wrno: string;

  @Column({ name: 'opbal', type: 'numeric', precision: 18, scale: 2, default: 0 })
  openingBalance: number;

  @Column({ name: 'totdr', type: 'numeric', precision: 18, scale: 2, default: 0 })
  totalDebit: number;

  @Column({ name: 'totcr', type: 'numeric', precision: 18, scale: 2, default: 0 })
  totalCredit: number;

  @Column({ name: 'closebal', type: 'numeric', precision: 18, scale: 2, default: 0 })
  closingBalance: number;

  @Column({ name: 'amount', type: 'numeric', precision: 19, scale: 4, default: 0 })
  amount: number;

  @Column({ name: 'interest', type: 'numeric', precision: 19, scale: 4, default: 0 })
  interest: number;

  @Column({ name: 'post', type: 'varchar', length: 1, default: 'Y' })
  post: string;

  @Column({ name: 'paid', type: 'varchar', length: 1, default: 'N' })
  paid: string;

  @Column({ name: 'paydate', type: 'timestamp', nullable: true })
  payDate: Date;

  @Column({ name: 'vchrno', type: 'varchar', length: 6, default: '' })
  voucherNumber: string;

  @Column({ name: 'account_number', type: 'numeric', precision: 9, scale: 0, nullable: true })
  accountNumber: string;

  // BUG FIX 53: rowid is NOT NULL with no default/sequence and wasn't mapped —
  // same class of gap as ledger.ledgerid. Must be generated explicitly.
  @Column({ name: 'rowid', type: 'integer' })
  rowId: number;

  @ManyToOne(() => InterestMaster, (interestMaster) => interestMaster.interestPaidRecords)
  @JoinColumn({ name: 'id' })
  interestMaster: InterestMaster;
}