import { Entity, PrimaryColumn, ManyToOne, JoinColumn } from 'typeorm';
import { UserLevelMaster } from './user-level-master.entity';
import { MenuMaster } from './menu-master.entity';

@Entity('userleveldefaultrights')
export class UserLevelDefaultRights {
  @PrimaryColumn({ name: 'userlevelid', type: 'smallint' })
  userlevelid: number;

  @PrimaryColumn({ name: 'menuid', type: 'integer' })
  menuid: number;

  // Relationships
  @ManyToOne(() => UserLevelMaster, (userLevel) => userLevel.defaultRights)
  @JoinColumn({ name: 'userlevelid' })
  userLevel: UserLevelMaster;

  @ManyToOne(() => MenuMaster, (menu) => menu.defaultRights)
  @JoinColumn({ name: 'menuid' })
  menu: MenuMaster;
}
