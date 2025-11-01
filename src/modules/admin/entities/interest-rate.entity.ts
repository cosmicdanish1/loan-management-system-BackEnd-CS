import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
} from 'typeorm';

export enum InterestRateType {
  LOAN = 'loan',
  FIXED_DEPOSIT = 'fixed_deposit',
  RECURRING_DEPOSIT = 'recurring_deposit',
  SAVINGS = 'savings',
}

export enum InterestCalculationMethod {
  SIMPLE = 'simple',
  COMPOUND = 'compound',
  REDUCING_BALANCE = 'reducing_balance',
}

@Entity('interest_rates')
export class InterestRate {
  @PrimaryGeneratedColumn()
  id: number;

  @Column()
  name: string;

  @Column('text', { nullable: true })
  description: string;

  @Column({
    type: 'varchar',
    enum: InterestRateType,
  })
  type: InterestRateType;

  @Column('decimal', { precision: 5, scale: 2 })
  rate: number; // Interest rate percentage

  @Column({
    type: 'varchar',
    enum: InterestCalculationMethod,
    default: InterestCalculationMethod.SIMPLE,
  })
  calculationMethod: InterestCalculationMethod;

  @Column('decimal', { precision: 15, scale: 2, nullable: true })
  minAmount: number; // Minimum amount for this rate

  @Column('decimal', { precision: 15, scale: 2, nullable: true })
  maxAmount: number; // Maximum amount for this rate

  @Column({ nullable: true })
  minTenure: number; // Minimum tenure in days

  @Column({ nullable: true })
  maxTenure: number; // Maximum tenure in days

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

  // Helper method to check if rate is applicable
  isApplicable(amount: number, tenure?: number, date: Date = new Date()): boolean {
    // Check if rate is active
    if (!this.isActive) return false;

    // Check effective date range
    if (date < this.effectiveFrom) return false;
    if (this.effectiveTo && date > this.effectiveTo) return false;

    // Check amount range
    if (this.minAmount && amount < this.minAmount) return false;
    if (this.maxAmount && amount > this.maxAmount) return false;

    // Check tenure range
    if (tenure) {
      if (this.minTenure && tenure < this.minTenure) return false;
      if (this.maxTenure && tenure > this.maxTenure) return false;
    }

    return true;
  }
}
