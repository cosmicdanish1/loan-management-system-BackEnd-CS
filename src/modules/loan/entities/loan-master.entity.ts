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

  // Set when this case's balance was absorbed into a later loan of the same
  // type for the same member (loan consolidation, pass-transaction.service.ts)
  // — points at the new case's own loancaseno. Null for every ordinary,
  // never-consolidated loan.
  @Column({ type: 'numeric', precision: 18, scale: 0, nullable: true })
  consolidated_into_loancaseno: string;

  /** Snapshot of the payment model at origination/consolidation. */
  @Column({ type: 'varchar', length: 32, default: 'SEPARATE_INTEREST' })
  loan_payment_model: string;

  /** The one supported interest method for all new loans. */
  @Column({ type: 'varchar', length: 32, default: 'REDUCING_BALANCE' })
  loan_interest_method: string;
}
