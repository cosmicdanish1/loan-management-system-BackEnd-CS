import { Entity, Column, PrimaryColumn, OneToMany } from 'typeorm';
import { UserMaster } from './user-master.entity';
import { UserLevelDefaultRights } from './user-level-default-rights.entity';

@Entity('userlevelmaster')
export class UserLevelMaster {
  @PrimaryColumn({ name: 'userlevelid', type: 'smallint' })
  userlevelid: number;

  @Column({ name: 'userlevel', type: 'varchar', length: 20, default: '' })
  userlevel: string;

  // Relationships
  @OneToMany(() => UserMaster, (user) => user.userLevel)
  users: UserMaster[];

  @OneToMany(
    () => UserLevelDefaultRights,
    (defaultRights) => defaultRights.userLevel,
  )
  defaultRights: UserLevelDefaultRights[];
}
