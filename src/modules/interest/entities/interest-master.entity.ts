import { Entity, Column, PrimaryColumn, OneToMany } from 'typeorm';
import { InterestPaid } from './interest-paid.entity';

@Entity('interestmaster')
export class InterestMaster {
  // BUG FIX 53: this was @PrimaryGeneratedColumn, but the real DB column has no
  // sequence/default (confirmed via information_schema — nullable numeric, no
  // default) — TypeORM's "generated" behavior was a fiction. An insert relying on
  // it would leave id NULL, and the very next line in the service that called
  // `.toString()` on it would throw. Must be generated explicitly before save.
  @PrimaryColumn({ name: 'id', type: 'numeric', precision: 18, scale: 0 })
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