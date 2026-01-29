import { Entity, Column, PrimaryColumn } from 'typeorm';

@Entity('wing_master')
export class Wing {
    @PrimaryColumn({ name: 'wingno', length: 10 })
    wingId: string;

    @Column({ name: 'wingname', length: 100, nullable: true })
    wingName: string;

    @Column({ name: 'status_state', length: 10, nullable: true })
    state: string;
}
