import { Entity, Column, PrimaryColumn } from 'typeorm';

@Entity('demand_master')
export class DemandMaster {
    @PrimaryColumn({ name: 'dmnd_srno' })
    id: number;

    @Column({ name: 'demand_for_month' })
    month: number;

    @Column({ name: 'demand_for_year' })
    year: number;

    @Column({ name: 'mbno', type: 'numeric' })
    memberNo: number;

    @Column({ name: 'balance_for_month', type: 'numeric' })
    balance: number;

    @Column({ name: 'totaldemand', type: 'numeric' })
    totalDemand: number;

    // We can map specific heads if needed, but balance is key for "Short Recovery"
}
