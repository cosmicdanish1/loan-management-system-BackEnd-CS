import { Entity, Column, PrimaryColumn, ManyToOne, JoinColumn } from 'typeorm';
import { UserMaster } from './user-master.entity';
import { MenuMaster } from './menu-master.entity';

@Entity('userrights')
export class UserRights {
  @PrimaryColumn({ name: 'userid', type: 'integer' })
  userid: number;

  @PrimaryColumn({ name: 'menuid', type: 'integer' })
  menuid: number;

  // Relationships
  @ManyToOne(() => UserMaster, (user) => user.userRights)
  @JoinColumn({ name: 'userid' })
  user: UserMaster;

  @ManyToOne(() => MenuMaster, (menu) => menu.userRights)
  @JoinColumn({ name: 'menuid' })
  menu: MenuMaster;
}
