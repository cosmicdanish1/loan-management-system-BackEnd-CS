import { Entity, Column, ManyToOne, JoinColumn, PrimaryColumn } from 'typeorm';
import { UserMaster } from './user-master.entity';

@Entity('userinfo')
export class UserInfo {
  @PrimaryColumn({ name: 'userid', type: 'integer' })
  userid: number;

  @Column({ name: 'hostname', type: 'varchar', length: 20, default: '' })
  hostname: string;

  @Column({
    name: 'abnormal_status',
    type: 'varchar',
    length: 1,
    default: 'N',
  })
  abnormalStatus: string;

  // Relationships
  @ManyToOne(() => UserMaster, (user) => user.userInfo)
  @JoinColumn({ name: 'userid' })
  user: UserMaster;

  // Computed property
  get hasAbnormalStatus(): boolean {
    return this.abnormalStatus === 'Y';
  }
}
