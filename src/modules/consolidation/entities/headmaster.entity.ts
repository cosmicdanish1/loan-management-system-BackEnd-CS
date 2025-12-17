import { Entity, PrimaryColumn, Column } from 'typeorm';

@Entity('headmaster')
export class HeadMaster {
  @PrimaryColumn({ type: 'varchar', length: 5 })
  code: string;

  @Column({ type: 'varchar', length: 5, default: '' })
  parent_code: string;

  @Column({ type: 'varchar', length: 12, default: '' })
  hposition: string;

  @Column({ type: 'varchar', length: 100, default: '' })
  head_name: string;

  @Column({ type: 'varchar', length: 4, default: 'N' })
  interest: string;

  @Column({ type: 'varchar', length: 4, default: 'OTH' })
  headtype: string;

  @Column({ type: 'numeric', precision: 19, scale: 4, default: 0 })
  op_bal: number;

  @Column({ type: 'varchar', length: 4, default: '' })
  pflag: string;
}