import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  ManyToOne,
  JoinColumn,
} from 'typeorm';
import { Member } from '../../member/entities/member.entity';

export enum InterestPostingType {
  LOAN_INTEREST = 'loan_interest',
  DEPOSIT_INTEREST = 'deposit_interest',
  SAVINGS_INTEREST = 'savings_interest',
}

export enum InterestPostingStatus {
  PENDING = 'pending',
  POSTED = 'posted',
  REVERSED = 'reversed',
}

@Entity('interest_postings')
export class InterestPosting {
  @PrimaryGeneratedColumn()
  id: number;

  @Column()
  memberId: number;

  @ManyToOne(() => Member, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'memberId' })
  member: Member;

  @Column()
  accountId: number; // Loan ID, Deposit ID, etc.

  @Column()
  accountNumber: string;

  @Column({
    type: 'varchar',
    enum: InterestPostingType,
  })
  type: InterestPostingType;

  @Column('decimal', { precision: 15, scale: 2 })
  principalAmount: number;

  @Column('decimal', { precision: 5, scale: 2 })
  interestRate: number;

  @Column('decimal', { precision: 15, scale: 2 })
  interestAmount: number;

  @Column()
  calculationDate: Date;

  @Column()
  postingDate: Date;

  @Column({
    type: 'varchar',
    enum: InterestPostingStatus,
    default: InterestPostingStatus.PENDING,
  })
  status: InterestPostingStatus;

  @Column({ nullable: true })
  transactionId: number; // Reference to the transaction created

  @Column('text', { nullable: true })
  remarks: string;

  @CreateDateColumn()
  createdAt: Date;

  // Helper methods
  isPosted(): boolean {
    return this.status === InterestPostingStatus.POSTED;
  }

  isReversed(): boolean {
    return this.status === InterestPostingStatus.REVERSED;
  }

  isPending(): boolean {
    return this.status === InterestPostingStatus.PENDING;
  }
}
