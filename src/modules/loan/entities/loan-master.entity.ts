import { Entity, Column, PrimaryColumn, ViewColumn, ViewEntity } from 'typeorm';

@Entity('loan_master')
export class LoanMaster {
  @PrimaryColumn({ type: 'numeric', precision: 18, scale: 0 })
  mbno: string;

  @PrimaryColumn({ type: 'varchar', length: 3 })
  loantype: string;

  @PrimaryColumn({ type: 'numeric', precision: 18, scale: 0 })
  loancaseno: string;

  @Column({ type: 'numeric', precision: 19, scale: 4, default: 0 })
  loan_amt: number;

  @Column({ type: 'timestamp', default: () => 'CURRENT_TIMESTAMP' })
  payment_date: Date;

  @Column({ type: 'numeric', precision: 19, scale: 4, default: 0 })
  rate: number;

  @Column({ type: 'smallint', default: 0 })
  no_of_instal: number;

  @Column({ type: 'numeric', precision: 19, scale: 4, default: 0 })
  instal_amt: number;

  @Column({ type: 'numeric', precision: 19, scale: 4, default: 0 })
  balance: number;

  @Column({ type: 'numeric', precision: 19, scale: 4, default: 0 })
  openbalance: number;

  @Column({ type: 'varchar', length: 50, default: '' })
  purpose: string;

  @Column({ type: 'numeric', precision: 14, scale: 2, nullable: true })
  intt_amount: number;

  @Column({ type: 'numeric', precision: 10, scale: 2, default: 0 })
  penalrate: number;

  /** Day of the month (in the installment's own due month) through which no penal accrues. Frozen at disbursement, like rate/penalrate. */
  @Column({ type: 'smallint', default: 0 })
  gracedays: number;

  /** Same-month-late flat fee: (smpenalpct% × unpaid principal) / smpenaldiv. Frozen at disbursement. */
  @Column({ type: 'numeric', precision: 5, scale: 2, default: 1 })
  smpenalpct: number;

  @Column({ type: 'numeric', precision: 5, scale: 2, default: 4 })
  smpenaldiv: number;
}
