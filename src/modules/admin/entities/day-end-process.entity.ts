import {
  Entity,
  PrimaryColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
} from 'typeorm';

export enum DayEndStatus {
  PENDING = 'pending',
  IN_PROGRESS = 'in_progress',
  COMPLETED = 'completed',
  FAILED = 'failed',
}

export enum DayEndProcessType {
  INTEREST_CALCULATION = 'interest_calculation',
  BACKUP_CREATION = 'backup_creation',
  REPORT_GENERATION = 'report_generation',
  DATA_VALIDATION = 'data_validation',
  SYSTEM_CLEANUP = 'system_cleanup',
}

@Entity('day_end_processes')
export class DayEndProcess {
  @PrimaryColumn()
  id: number;

  @Column()
  processDate: Date;

  // FIX BUG 8: type:'varchar' causes TypeORM to silently ignore the enum option.
  // Use type:'enum' so the DB enforces valid values.
  @Column({
    type: 'enum',
    enum: DayEndStatus,
    default: DayEndStatus.PENDING,
  })
  status: DayEndStatus;

  @Column()
  startedAt: Date;

  @Column({ nullable: true })
  completedAt: Date;

  @Column({ nullable: true })
  failedAt: Date;

  @Column('text', { nullable: true })
  errorMessage: string;

  @Column('json', { nullable: true })
  processResults: any; // JSON object containing process results

  @Column('json', { nullable: true })
  processSteps: DayEndProcessStep[]; // Array of process steps

  @Column({ nullable: true })
  initiatedBy: number; // User ID who initiated the process

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;

  // Helper methods
  isCompleted(): boolean {
    return this.status === DayEndStatus.COMPLETED;
  }

  isFailed(): boolean {
    return this.status === DayEndStatus.FAILED;
  }

  isInProgress(): boolean {
    return this.status === DayEndStatus.IN_PROGRESS;
  }

  getDuration(): number | null {
    if (!this.startedAt) return null;
    const endTime = this.completedAt || this.failedAt || new Date();
    return endTime.getTime() - this.startedAt.getTime();
  }
}

export interface DayEndProcessStep {
  type: DayEndProcessType;
  name: string;
  status: DayEndStatus;
  startedAt?: Date;
  completedAt?: Date;
  errorMessage?: string;
  result?: any;
}
