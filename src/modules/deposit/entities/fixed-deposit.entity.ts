import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  DeleteDateColumn,
  ManyToOne,
  JoinColumn,
} from 'typeorm';
import { Member } from '../../member/entities/member.entity';

@Entity('fixed_deposits')
export class FixedDeposit {
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

  @Column({ type: 'date' })
  depositDate: Date;

  @Column({ type: 'date' })
  maturityDate: Date;

  @Column({ type: 'integer' })
  tenureMonths: number;

  @Column({ type: 'decimal', precision: 15, scale: 2 })
  maturityAmount: number;

  @Column({ type: 'decimal', precision: 15, scale: 2, default: 0 })
  interestAccrued: number;

  @Column({ default: 'ACTIVE' })
  status: string; // ACTIVE, MATURED, CLOSED, PREMATURE_CLOSURE

  @Column({ type: 'date', nullable: true })
  closureDate: Date;

  @Column({ type: 'decimal', precision: 15, scale: 2, nullable: true })
  closureAmount: number;

  @Column({ type: 'decimal', precision: 15, scale: 2, nullable: true })
  penaltyAmount: number;

  @Column({ type: 'text', nullable: true })
  closureReason: string;

  @Column({ type: 'boolean', default: false })
  isAutoRenewal: boolean;

  @Column({ type: 'date', nullable: true })
  lastInterestCalculationDate: Date;

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

  get daysToMaturity(): number {
    const today = new Date();
    const maturity = new Date(this.maturityDate);
    const diffTime = maturity.getTime() - today.getTime();
    return Math.ceil(diffTime / (1000 * 60 * 60 * 24));
  }

  get currentValue(): number {
    if (this.status === 'CLOSED') {
      return Number(this.closureAmount || 0);
    }
    return Number(this.principalAmount) + Number(this.interestAccrued);
  }

  // Calculate maturity amount based on compound interest
  calculateMaturityAmount(): number {
    const principal = Number(this.principalAmount);
    const rate = Number(this.interestRate) / 100;
    const time = this.tenureMonths / 12;
    
    // Compound interest formula: A = P(1 + r)^t
    return principal * Math.pow(1 + rate, time);
  }

  // Calculate penalty for premature closure
  calculatePenaltyAmount(penaltyRate: number = 1): number {
    const currentInterest = this.interestAccrued;
    return Number(currentInterest) * (penaltyRate / 100);
  }
}
