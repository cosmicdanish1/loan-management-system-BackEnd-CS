import { Entity, Column, PrimaryGeneratedColumn } from 'typeorm';

@Entity('tblcashbook')
export class CashBook {
    @PrimaryGeneratedColumn()
    id: number;

    @Column({ name: 'headcode', nullable: true })
    headcode: string;

    @Column({ name: 'headname', nullable: true })
    headname: string;

    @Column({ name: 'rcash', type: 'numeric', nullable: true })
    rcash: number;

    @Column({ name: 'rtransfer', type: 'numeric', nullable: true })
    rtransfer: number;

    @Column({ name: 'pcash', type: 'numeric', nullable: true })
    pcash: number;

    @Column({ name: 'ptransfer', type: 'numeric', nullable: true })
    ptransfer: number;

    @Column({ name: 'trans_date', type: 'date', nullable: true })
    trans_date: Date;
}
