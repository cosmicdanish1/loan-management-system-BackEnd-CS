import { Entity, Column, PrimaryColumn, UpdateDateColumn } from 'typeorm';

@Entity('sequence_master')
export class SequenceMaster {
    @PrimaryColumn()
    sequence_key: string;

    @Column({ type: 'bigint', default: 0 })
    last_value: string;

    @Column({ nullable: true })
    prefix: string;

    @Column({ default: false })
    reset_yearly: boolean;

    @Column({ nullable: true })
    last_year: number;

    @UpdateDateColumn()
    updated_at: Date;
}
