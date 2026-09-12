import { Entity, Column, PrimaryGeneratedColumn, OneToMany } from 'typeorm';
import { InterestPaid } from './interest-paid.entity';

@Entity('interestmaster')
export class InterestMaster {
  @PrimaryGeneratedColumn({ name: 'id' })
  id: number;

  @Column({ name: 'inttype', type: 'varchar', length: 3, default: '' })
  intType: string;

  @Column({ name: 'frdt', type: 'timestamp', nullable: true })
  fromDate: Date;

  @Column({ name: 'todt', type: 'timestamp', nullable: true })
  toDate: Date;

  @Column({ name: 'rate', type: 'numeric', precision: 19, scale: 4, default: 0 })
  rate: number;

  @OneToMany(() => InterestPaid, (interestPaid) => interestPaid.interestMaster)
  interestPaidRecords: InterestPaid[];
}