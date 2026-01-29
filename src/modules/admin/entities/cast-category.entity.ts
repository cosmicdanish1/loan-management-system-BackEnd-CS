import { Entity, Column, PrimaryColumn } from 'typeorm';

@Entity('castcategorymaster')
export class CastCategory {
    @PrimaryColumn({ name: 'id', type: 'int' })
    id: number;

    @Column({ name: 'castcategory', length: 30 })
    name: string;
}
