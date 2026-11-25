import { Entity, Column, PrimaryColumn } from 'typeorm';

/**
 * A wing (Division / RO). Stored in WINGMAST, the table the members, loans, lookups and reports join to
 * (the window used to save into wing_master, which nothing else reads).
 */
@Entity('wingmast')
export class Wing {
    @PrimaryColumn({ name: 'wingno', type: 'varchar', length: 6 })
    wingId: string;

    @Column({ name: 'wname', type: 'varchar', length: 45, nullable: true })
    wingName: string;

    /** 1 = In State, 0 = Out State */
    @Column({ name: 'winstate', type: 'smallint', default: 1 })
    state: number;
}
