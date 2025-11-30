import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  DeleteDateColumn,
  ManyToOne,
  OneToMany,
  JoinColumn,
} from 'typeorm';
import { Member } from '../../member/entities/member.entity';
import { LoanPayment } from './loan-payment.entity';

@Entity('loan_accounts')
export class LoanAccount {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ unique: true, length: 20 })
  accountNumber: string;

  @ManyToOne(() => Member, { eager: true })
  @JoinColumn({ name: 'memberId' })
  member: Member;

  @Column()
  memberId: number;

  @Column({ type: 'decimal', precision: 15, scale: 2 })
  principalAmount: number;

  @Column({ type: 'decimal', precision: 5, scale: 2 })
  interestRate: number;

  @Column({ type: 'decimal', precision: 15, scale: 2 })
  outstandingBalance: number;

  @Column({ length: 50 })
  loanType: string;

  @Column({ type: 'date' })
  disbursementDate: Date;

  @Column({ type: 'date' })
  maturityDate: Date;

  @Column({ type: 'integer', default: 12 })
  tenureMonths: number;

  @Column({ type: 'decimal', precision: 15, scale: 2, nullable: true })
  emiAmount: number;

  @Column({ length: 100, nullable: true })
  purpose: string;

  @Column({ length: 100, nullable: true })
  suretyName: string;

  @Column({ length: 15, nullable: true })
  suretyPhone: string;

  @Column({ type: 'text', nullable: true })
  suretyAddress: string;

  @Column({ default: 'ACTIVE' })
  status: string; // ACTIVE, CLOSED, DEFAULTED, WRITTEN_OFF

  @Column({ type: 'decimal', precision: 15, scale: 2, default: 0 })
  totalInterestAccrued: number;

  @Column({ type: 'decimal', precision: 15, scale: 2, default: 0 })
  totalPaid: number;

  @Column({ type: 'date', nullable: true })
  lastInterestCalculationDate: Date;

  @Column({ type: 'date', nullable: true })
  closureDate: Date;

  @OneToMany(() => LoanPayment, payment => payment.loanAccount)
  payments: LoanPayment[];

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;

  @DeleteDateColumn()
  deletedAt: Date;

  // Computed properties
  get isOverdue(): boolean {
    return this.status === 'ACTIVE' && new Date() > this.maturityDate;
  }

  get remainingBalance(): number {
    return Number(this.outstandingBalance);
  }
}
