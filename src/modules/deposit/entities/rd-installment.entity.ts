import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  ManyToOne,
  JoinColumn,
} from 'typeorm';
import { RecurringDeposit } from './recurring-deposit.entity';

@Entity('rd_installments')
export class RdInstallment {
  @PrimaryGeneratedColumn()
  id: number;

  @ManyToOne(() => RecurringDeposit, rd => rd.installments)
  @JoinColumn({ name: 'recurringDepositId' })
  recurringDeposit: RecurringDeposit;

  @Column()
  recurringDepositId: number;

  @Column({ type: 'int' })
  installmentNumber: number;

  @Column({ type: 'decimal', precision: 15, scale: 2 })
  amount: number;

  @Column({ type: 'date' })
  dueDate: Date;

  @Column({ type: 'date', nullable: true })
  paidDate: Date;

  @Column({ type: 'decimal', precision: 15, scale: 2, nullable: true })
  paidAmount: number;

  @Column({ type: 'decimal', precision: 15, scale: 2, default: 0 })
  penaltyAmount: number;

  @Column({ default: 'PENDING' })
  status: string; // PENDING, PAID, OVERDUE, WAIVED

  @Column({ type: 'text', nullable: true })
  remarks: string;

  @Column({ length: 50, nullable: true })
  receiptNumber: string;

  @Column({ length: 50, nullable: true })
  paymentMode: string; // CASH, CHEQUE, ONLINE, TRANSFER

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;

  // Computed properties
  get isOverdue(): boolean {
    return this.status === 'PENDING' && new Date() > this.dueDate;
  }

  get daysPastDue(): number {
    if (!this.isOverdue) return 0;
    const today = new Date();
    const due = new Date(this.dueDate);
    const diffTime = today.getTime() - due.getTime();
    return Math.ceil(diffTime / (1000 * 60 * 60 * 24));
  }

  get outstandingAmount(): number {
    if (this.status === 'PAID') return 0;
    return Number(this.amount) + Number(this.penaltyAmount) - Number(this.paidAmount || 0);
  }
}
