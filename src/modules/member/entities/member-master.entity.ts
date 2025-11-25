import { Entity, Column, PrimaryColumn } from 'typeorm';

@Entity('member_master')
export class MemberMaster {
  @PrimaryColumn({ type: 'numeric', precision: 18, scale: 0 })
  mbno: string;

  @Column({ type: 'varchar', length: 5, default: '' })
  prefix: string;

  @Column({ type: 'varchar', length: 100, nullable: true })
  f_name: string;

  @Column({ type: 'varchar', length: 50, nullable: true })
  m_name: string;

  @Column({ type: 'varchar', length: 50, nullable: true })
  l_name: string;

  @Column({ type: 'varchar', length: 1, default: '' })
  sex: string;

  @Column({ type: 'varchar', length: 40, default: '' })
  desig: string;

  @Column({ type: 'varchar', length: 200, default: '' })
  present_address: string;

  @Column({ type: 'varchar', length: 200, default: '' })
  permanent_address: string;

  @Column({ type: 'varchar', length: 6, default: '0' })
  wingno: string;

  @Column({ type: 'integer', default: 0 })
  officeno: number;

  @Column({ type: 'varchar', length: 2, default: '' })
  age: string;

  @Column({ type: 'timestamp', nullable: true })
  dob: Date;

  @Column({ type: 'timestamp', nullable: true })
  date_of_appt: Date;

  @Column({ type: 'timestamp', nullable: true })
  dor: Date;

  @Column({ type: 'numeric', precision: 18, scale: 0, default: 0 })
  gross_salary: number;

  @Column({ type: 'numeric', precision: 18, scale: 0, default: 0 })
  basic_pay: number;

  @Column({ type: 'varchar', length: 10, default: '' })
  pfno: string;

  @Column({ type: 'varchar', length: 1, default: 'N' })
  flg_retire: string;

  @Column({ type: 'timestamp', nullable: true })
  memb_date: Date;

  @Column({ type: 'varchar', length: 50, nullable: true })
  dept_name: string;

  @Column({ type: 'char', length: 1, nullable: true })
  isactive: string;

  // Computed property for full name
  get fullName(): string {
    const parts = [this.f_name, this.m_name, this.l_name].filter(Boolean);
    return parts.join(' ').trim();
  }
}
