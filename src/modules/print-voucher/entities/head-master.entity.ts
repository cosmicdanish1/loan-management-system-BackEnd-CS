import { Entity, Column, PrimaryColumn } from 'typeorm';

@Entity('headmaster')
export class HeadMaster {
    @PrimaryColumn({ name: 'code', type: 'varchar', length: 5 })
    code: string;

    @Column({ name: 'head_name', type: 'varchar', length: 100, default: '' })
    head_name: string;

    @Column({ name: 'parent_code', type: 'varchar', length: 5, default: '' })
    parent_code: string;

    @Column({ name: 'headtype', type: 'varchar', length: 4, default: 'OTH' })
    headtype: string;
}
