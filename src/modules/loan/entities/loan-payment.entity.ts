import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  ManyToOne,
  JoinColumn,
} from 'typeorm';
import { LoanAccount } from './loan-account.entity';

@Entity('loan_payments')
export class LoanPayment {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ unique: true, length: 20 })
  paymentNumber: string;

  @ManyToOne(() => LoanAccount, loanAccount => loanAccount.payments)
  @JoinColumn({ name: 'loanAccountId' })
  loanAccount: LoanAccount;

  @Column()
  loanAccountId: number;

  @Column({ type: 'decimal', precision: 15, scale: 2 })
  amount: number;

  @Column({ type: 'decimal', precision: 15, scale: 2, default: 0 })
  principalAmount: number;

  @Column({ type: 'decimal', precision: 15, scale: 2, default: 0 })
  interestAmount: number;

  @Column({ type: 'decimal', precision: 15, scale: 2, default: 0 })
  penaltyAmount: number;

  @Column({ type: 'date' })
  paymentDate: Date;

  @Column({ length: 50 })
  paymentMethod: string; // CASH, CHEQUE, BANK_TRANSFER, UPI

  @Column({ length: 50, nullable: true })
  referenceNumber: string; // Cheque number, transaction ID, etc.

  @Column({ type: 'text', nullable: true })
  remarks: string;

  @Column({ length: 20, nullable: true })
  receiptNumber: string;

  @Column({ default: 'COMPLETED' })
  status: string; // COMPLETED, PENDING, CANCELLED

  @Column({ type: 'decimal', precision: 15, scale: 2 })
  balanceAfterPayment: number;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
