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
import { Transaction } from './transaction.entity';

@Entity('vouchers')
export class Voucher {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ unique: true, length: 20 })
  voucherNumber: string;

  @Column({ type: 'date' })
  voucherDate: Date;

  @Column({ length: 50 })
  voucherType: string; // PAYMENT, RECEIPT, JOURNAL, CONTRA

  @Column({ type: 'decimal', precision: 15, scale: 2 })
  totalAmount: number;

  @Column({ type: 'text' })
  description: string;

  @ManyToOne(() => Member, { nullable: true, eager: true })
  @JoinColumn({ name: 'memberId' })
  member: Member;

  @Column({ nullable: true })
  memberId: number;

  @Column({ length: 100, nullable: true })
  payeeName: string;

  @Column({ length: 50, nullable: true })
  chequeNumber: string;

  @Column({ type: 'date', nullable: true })
  chequeDate: Date;

  @Column({ length: 100, nullable: true })
  bankName: string;

  @Column({ default: 'ACTIVE' })
  status: string; // ACTIVE, CANCELLED, REVERSED

  @Column({ type: 'text', nullable: true })
  remarks: string;

  @Column({ nullable: true })
  authorizedBy: number;

  @Column({ type: 'datetime', nullable: true })
  authorizedAt: Date;

  @Column({ nullable: true })
  cancelledBy: number;

  @Column({ type: 'datetime', nullable: true })
  cancelledAt: Date;

  @Column({ type: 'text', nullable: true })
  cancellationReason: string;

  @OneToMany(() => Transaction, transaction => transaction.voucherNumber, {
    cascade: true,
  })
  transactions: Transaction[];

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;

  @DeleteDateColumn()
  deletedAt: Date;

  // Computed properties
  get isCancelled(): boolean {
    return this.status === 'CANCELLED';
  }

  get isAuthorized(): boolean {
    return !!this.authorizedBy && !!this.authorizedAt;
  }

  get canBeCancelled(): boolean {
    return this.status === 'ACTIVE';
  }
}
