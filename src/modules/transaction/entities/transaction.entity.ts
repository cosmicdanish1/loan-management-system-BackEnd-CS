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

@Entity('transactions')
export class Transaction {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ unique: true, length: 20 })
  transactionNumber: string;

  @Column({ type: 'date' })
  transactionDate: Date;

  @Column({ length: 50 })
  transactionType: string; // PAYMENT, RECEIPT, TRANSFER, JOURNAL

  @Column({ type: 'decimal', precision: 15, scale: 2 })
  amount: number;

  @Column({ type: 'text' })
  description: string;

  @Column({ length: 100 })
  debitAccount: string;

  @Column({ length: 100 })
  creditAccount: string;

  @ManyToOne(() => Member, { nullable: true, eager: true })
  @JoinColumn({ name: 'memberId' })
  member: Member;

  @Column({ nullable: true })
  memberId: number;

  @Column({ length: 20, nullable: true })
  voucherNumber: string;

  @Column({ length: 50, nullable: true })
  referenceType: string; // LOAN_PAYMENT, DEPOSIT_WITHDRAWAL, etc.

  @Column({ nullable: true })
  referenceId: number;

  @Column({ default: 'POSTED' })
  status: string; // POSTED, REVERSED, CANCELLED

  @Column({ type: 'text', nullable: true })
  remarks: string;

  @Column({ nullable: true })
  reversedTransactionId: number;

  @Column({ type: 'datetime', nullable: true })
  reversedAt: Date;

  @Column({ nullable: true })
  reversedBy: number;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;

  @DeleteDateColumn()
  deletedAt: Date;

  // Computed properties
  get isReversed(): boolean {
    return this.status === 'REVERSED';
  }

  get canBeReversed(): boolean {
    return this.status === 'POSTED' && !this.reversedTransactionId;
  }
}
