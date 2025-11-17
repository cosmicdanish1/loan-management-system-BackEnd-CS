import { Entity, Column, PrimaryColumn, OneToMany } from 'typeorm';
import { UserRights } from './user-rights.entity';
import { UserLevelDefaultRights } from './user-level-default-rights.entity';

@Entity('menumaster')
export class MenuMaster {
  @PrimaryColumn({ name: 'menuid', type: 'integer' })
  menuid: number;

  @Column({ name: 'menuname', type: 'varchar', length: 50, default: '' })
  menuname: string;

  @Column({ name: 'menudesc', type: 'varchar', length: 50, default: '' })
  menudesc: string;

  @Column({ name: 'visibleflag', type: 'char', length: 1, nullable: true })
  visibleflag: string;

  // Relationships
  @OneToMany(() => UserRights, (userRights) => userRights.menu)
  userRights: UserRights[];

  @OneToMany(
    () => UserLevelDefaultRights,
    (defaultRights) => defaultRights.menu,
  )
  defaultRights: UserLevelDefaultRights[];

  // Computed property
  get isVisible(): boolean {
    return this.visibleflag === 'Y';
  }
}
