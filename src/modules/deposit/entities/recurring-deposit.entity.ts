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
import { RdInstallment } from './rd-installment.entity';

@Entity('recurring_deposits')
export class RecurringDeposit {
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
  monthlyInstallment: number;

  @Column({ type: 'decimal', precision: 5, scale: 2 })
  interestRate: number;

  @Column({ type: 'date' })
  startDate: Date;

  @Column({ type: 'date' })
  maturityDate: Date;

  @Column({ type: 'int' })
  tenureMonths: number;

  @Column({ type: 'decimal', precision: 15, scale: 2 })
  maturityAmount: number;

  @Column({ type: 'decimal', precision: 15, scale: 2, default: 0 })
  totalDeposited: number;

  @Column({ type: 'decimal', precision: 15, scale: 2, default: 0 })
  interestAccrued: number;

  @Column({ type: 'int', default: 0 })
  installmentsPaid: number;

  @Column({ type: 'int', default: 0 })
  installmentsMissed: number;

  @Column({ default: 'ACTIVE' })
  status: string; // ACTIVE, MATURED, CLOSED, DEFAULTED

  @Column({ type: 'date', nullable: true })
  closureDate: Date;

  @Column({ type: 'decimal', precision: 15, scale: 2, nullable: true })
  closureAmount: number;

  @Column({ type: 'decimal', precision: 15, scale: 2, nullable: true })
  penaltyAmount: number;

  @Column({ type: 'text', nullable: true })
  closureReason: string;

  @Column({ type: 'date', nullable: true })
  lastInstallmentDate: Date;

  @Column({ type: 'date', nullable: true })
  nextDueDate: Date;

  @OneToMany(() => RdInstallment, installment => installment.recurringDeposit)
  installments: RdInstallment[];

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;

  @DeleteDateColumn()
  deletedAt: Date;

  // Computed properties
  get isMatured(): boolean {
    return new Date() >= this.maturityDate;
  }

  get remainingInstallments(): number {
    return this.tenureMonths - this.installmentsPaid;
  }

  get isOverdue(): boolean {
    if (!this.nextDueDate || this.status !== 'ACTIVE') return false;
    return new Date() > this.nextDueDate;
  }

  get currentValue(): number {
    if (this.status === 'CLOSED') {
      return Number(this.closureAmount || 0);
    }
    return Number(this.totalDeposited) + Number(this.interestAccrued);
  }

  // Calculate maturity amount for RD
  calculateMaturityAmount(): number {
    const monthlyAmount = Number(this.monthlyInstallment);
    const rate = Number(this.interestRate) / 100 / 12; // Monthly rate
    const months = this.tenureMonths;
    
    // RD maturity formula: M = P * [((1+r)^n - 1) / r] * (1+r)
    if (rate === 0) {
      return monthlyAmount * months;
    }
    
    const factor = (Math.pow(1 + rate, months) - 1) / rate;
    return monthlyAmount * factor * (1 + rate);
  }

  // Calculate next due date
  calculateNextDueDate(): Date {
    if (!this.lastInstallmentDate) {
      return new Date(this.startDate);
    }
    
    const nextDue = new Date(this.lastInstallmentDate);
    nextDue.setMonth(nextDue.getMonth() + 1);
    return nextDue;
  }

  // Calculate penalty for missed installments
  calculatePenalty(penaltyRate: number = 2): number {
    return this.installmentsMissed * Number(this.monthlyInstallment) * (penaltyRate / 100);
  }
}
