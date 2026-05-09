import { Entity, Column, PrimaryColumn } from 'typeorm';

@Entity('office_master')
export class Office {
    @PrimaryColumn({ name: 'officeno', type: 'int' })
    officeId: number;

    @Column({ name: 'office_name', length: 100, nullable: true })
    officeName: string;

    @Column({ name: 'division', length: 50, nullable: true })
    division: string;

    @Column({ name: 'address', length: 255, nullable: true })
    address: string;

    @Column({ name: 'city', length: 50, nullable: true })
    city: string;
}
