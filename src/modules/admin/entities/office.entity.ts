import { Entity, Column, PrimaryColumn } from 'typeorm';

/**
 * An office / branch. Stored in DIVISION_MASTER, the table the members, loans, lookups and reports join to
 * (the window used to save into office_master, which nothing else reads). `wingId` is the wing (Division / RO)
 * the office belongs to; `division` is the division number (DIVNO) the legacy keeps for the office.
 */
@Entity('division_master')
export class Office {
    @PrimaryColumn({ name: 'officeno', type: 'int' })
    officeId: number;

    @Column({ name: 'wingno', type: 'varchar', length: 6 })
    wingId: string;

    @Column({ name: 'divno', type: 'int' })
    division: number;

    @Column({ name: 'name', type: 'varchar', length: 200 })
    officeName: string;

    @Column({ name: 'address', type: 'varchar', length: 200, default: '' })
    address: string;

    @Column({ name: 'city', type: 'varchar', length: 20, default: '' })
    city: string;
}
