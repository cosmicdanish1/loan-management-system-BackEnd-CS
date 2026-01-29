import { Entity, Column, PrimaryGeneratedColumn, CreateDateColumn } from 'typeorm';

@Entity('short_recovery_adjustment')
export class ShortRecoveryAdjustment {
    @PrimaryGeneratedColumn()
    id: number;

    @Column({ name: 'demand_id' })
    demandId: number; // Links to DemandMaster.id (dmnd_srno)

    @Column({ name: 'adjustment_amount', type: 'numeric' })
    adjustmentAmount: number;

    @Column()
    reason: string;

    @Column({ name: 'adjusted_by', nullable: true })
    adjustedBy: string;

    @CreateDateColumn({ name: 'adjusted_at' })
    adjustedAt: Date;
}
