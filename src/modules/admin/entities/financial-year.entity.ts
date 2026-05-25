import { Entity, Column, PrimaryColumn } from 'typeorm';

@Entity('yearend')
export class FinancialYear {
    @PrimaryColumn({ name: 'yearcode' })
    yearCode: number;

    @Column({ name: 'start_date', type: 'timestamp', nullable: true })
    startDate: Date;

    @Column({ name: 'end_date', type: 'timestamp', nullable: true })
    endDate: Date;

    @Column({ name: 'username', length: 40, nullable: true })
    username: string;

    // BUG FIX 5: Added closedAt to track when the financial year was formally closed.
    // Nullable so existing rows are unaffected; a non-null value means the year is locked.
    @Column({ name: 'closed_at', type: 'timestamp', nullable: true })
    closedAt: Date | null;
}
