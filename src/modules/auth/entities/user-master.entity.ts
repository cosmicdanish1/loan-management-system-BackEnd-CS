import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  ManyToOne,
  OneToMany,
  JoinColumn,
  BeforeInsert,
  BeforeUpdate,
} from 'typeorm';
import * as bcrypt from 'bcrypt';
import { UserLevelMaster } from './user-level-master.entity';
import { UserRights } from './user-rights.entity';
import { UserInfo } from './user-info.entity';
import { LoginTime } from './login-time.entity';

@Entity('usermaster')
export class UserMaster {
  @PrimaryGeneratedColumn({ name: 'userid' })
  userid: number;

  @Column({ name: 'susername', type: 'varchar', length: 20, unique: true })
  susername: string;

  @Column({ name: 'spassword', type: 'varchar', length: 255 })
  spassword: string;

  @Column({ name: 'userlevelid', type: 'smallint' })
  userlevelid: number;

  @Column({
    name: 'enable_disable',
    type: 'varchar',
    length: 1,
    default: 'E',
  })
  enableDisable: string; // 'E' = Enabled, 'D' = Disabled

  @Column({ name: 'date_of_creation', type: 'timestamp', nullable: true })
  dateOfCreation: Date;

  @Column({
    name: 'date_of_disable_enable',
    type: 'timestamp',
    nullable: true,
  })
  dateOfDisableEnable: Date;

  @Column({ name: 'login_status', type: 'varchar', length: 1, default: 'N' })
  loginStatus: string; // 'Y' = Logged in, 'N' = Logged out

  @Column({
    name: 'pass_transaction_flag',
    type: 'char',
    length: 1,
    nullable: true,
    default: 'N',
  })
  passTransactionFlag: string;

  // Relationships
  @ManyToOne(() => UserLevelMaster, { eager: true })
  @JoinColumn({ name: 'userlevelid' })
  userLevel: UserLevelMaster;

  @OneToMany(() => UserRights, (userRights) => userRights.user)
  userRights: UserRights[];

  @OneToMany(() => UserInfo, (userInfo) => userInfo.user)
  userInfo: UserInfo[];

  @OneToMany(() => LoginTime, (loginTime) => loginTime.user)
  loginTimes: LoginTime[];

  // Computed properties
  get isEnabled(): boolean {
    return this.enableDisable === 'E';
  }

  get isLoggedIn(): boolean {
    return this.loginStatus === 'Y';
  }

  get canPassTransactions(): boolean {
    return this.passTransactionFlag === 'Y';
  }

  // Password hashing
  @BeforeInsert()
  @BeforeUpdate()
  async hashPassword() {
    if (this.spassword && !this.spassword.startsWith('$2b$') && !this.spassword.startsWith('$2a$')) {
      // Only hash if not already hashed (bcrypt hashes start with $2b$ or $2a$)
      const saltRounds = 10;
      this.spassword = await bcrypt.hash(this.spassword, saltRounds);
    }
  }

  // Password validation
  async validatePassword(password: string): Promise<boolean> {
    // Check if password is hashed
    if (this.spassword.startsWith('$2b$') || this.spassword.startsWith('$2a$')) {
      // Compare with bcrypt
      return bcrypt.compare(password, this.spassword);
    } else {
      // Plain text comparison (for migration period)
      // This allows existing plain text passwords to work
      // They will be hashed on next update
      return this.spassword === password;
    }
  }
}
