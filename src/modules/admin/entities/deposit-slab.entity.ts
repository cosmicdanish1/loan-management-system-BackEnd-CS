import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
} from 'typeorm';

export enum DepositSlabType {
  FIXED_DEPOSIT = 'fixed_deposit',
  RECURRING_DEPOSIT = 'recurring_deposit',
  LOAN = 'loan',
}

@Entity('deposit_slabs')
export class DepositSlab {
  @PrimaryGeneratedColumn()
  id: number;

  @Column()
  name: string;

  @Column('text', { nullable: true })
  description: string;

  @Column({
    type: 'varchar',
    enum: DepositSlabType,
  })
  type: DepositSlabType;

  @Column('decimal', { precision: 15, scale: 2 })
  minAmount: number;

  @Column('decimal', { precision: 15, scale: 2 })
  maxAmount: number;

  @Column()
  minTenure: number; // Minimum tenure in days

  @Column()
  maxTenure: number; // Maximum tenure in days

  @Column('decimal', { precision: 5, scale: 2 })
  interestRate: number; // Interest rate percentage

  @Column('decimal', { precision: 5, scale: 2, nullable: true })
  penaltyRate: number; // Penalty rate for premature withdrawal

  @Column({ default: true })
  isActive: boolean;

  @Column()
  effectiveFrom: Date;

  @Column({ nullable: true })
  effectiveTo: Date;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;

  // Helper method to check if slab is applicable
  isApplicable(amount: number, tenure: number, date: Date = new Date()): boolean {
    // Check if slab is active
    if (!this.isActive) return false;

    // Check effective date range
    if (date < this.effectiveFrom) return false;
    if (this.effectiveTo && date > this.effectiveTo) return false;

    // Check amount range
    if (amount < this.minAmount || amount > this.maxAmount) return false;

    // Check tenure range
    if (tenure < this.minTenure || tenure > this.maxTenure) return false;

    return true;
  }

  // Calculate maturity amount
  calculateMaturityAmount(principalAmount: number, tenure: number): number {
    const years = tenure / 365;
    const maturityAmount = principalAmount * (1 + (this.interestRate / 100) * years);
    return Math.round(maturityAmount * 100) / 100;
  }

  // Calculate penalty amount for premature withdrawal
  calculatePenaltyAmount(principalAmount: number, actualTenure: number): number {
    if (!this.penaltyRate || actualTenure >= this.minTenure) return 0;
    
    const penaltyAmount = principalAmount * (this.penaltyRate / 100);
    return Math.round(penaltyAmount * 100) / 100;
  }
}
