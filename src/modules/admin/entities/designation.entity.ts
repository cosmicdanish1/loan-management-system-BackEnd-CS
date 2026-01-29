import { Entity, Column, PrimaryColumn } from 'typeorm';

@Entity('designation_master')
export class Designation {
    @PrimaryColumn({ name: 'designationcode', length: 20 })
    code: string;

    @Column({ name: 'designationname', length: 100 })
    name: string;

    @Column({ name: 'designationlevel', type: 'int', nullable: true })
    level: number;
}
