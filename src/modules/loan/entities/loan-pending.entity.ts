import { Entity, Column, PrimaryColumn, PrimaryGeneratedColumn } from 'typeorm';

@Entity('loan_pending')
export class LoanPending {
  @PrimaryGeneratedColumn({ type: 'bigint' })
  loancaseno: string;

  @PrimaryColumn({ type: 'numeric', precision: 18, scale: 0 })
  mbno: string;

  @Column({ type: 'varchar', length: 3 })
  loantype: string;

  @Column({ type: 'numeric', precision: 18, scale: 2, default: 0 })
  applied_amt: number;

  @Column({ type: 'numeric', precision: 18, scale: 2, default: 0 })
  sanctioned_amt: number;

  @Column({ type: 'timestamp', nullable: true })
  app_date: Date;

  @Column({ type: 'timestamp', nullable: true })
  sanctioned_date: Date;

  @Column({ type: 'smallint', default: 60 })
  no_of_instal: number;

  @Column({ type: 'numeric', precision: 18, scale: 0, default: 0 })
  g1mbno: string;

  @Column({ type: 'numeric', precision: 18, scale: 0, default: 0 })
  g2mbno: string;

  @Column({ type: 'numeric', precision: 18, scale: 0, default: 0 })
  g3mbno: string;

  @Column({ type: 'varchar', length: 50, default: '' })
  purpose: string;

  @Column({ type: 'varchar', length: 1, default: 'N' })
  flg_sanctioned: string;

  @Column({ type: 'varchar', length: 1, default: 'N' })
  flg_paid: string;

  @Column({ type: 'varchar', length: 10, nullable: true })
  form_number: string;
}
