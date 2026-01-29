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
}
