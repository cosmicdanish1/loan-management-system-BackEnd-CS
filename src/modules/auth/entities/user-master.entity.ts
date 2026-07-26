import {
  Entity,
  PrimaryColumn,
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
  @PrimaryColumn({ name: 'userid' })
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

  // Legacy password decryption (custom encryption from old system)
  private decryptLegacyPassword(encryptedPassword: string): string {
    // Character substitution map (reverse engineering from the data)
    // This is a simple Caesar cipher with custom mapping
    const decryptMap: { [key: string]: string } = {
      'b': 'a', 'c': 'b', 'd': 'c', 'e': 'd', 'f': 'e', 'g': 'f', 'h': 'g', 'i': 'h',
      'j': 'i', 'k': 'j', 'l': 'k', 'm': 'l', 'n': 'm', 'o': 'n', 'p': 'o', 'q': 'p',
      'r': 'q', 's': 'r', 't': 's', 'u': 't', 'v': 'u', 'w': 'v', 'x': 'w', 'y': 'x',
      'z': 'y', 'a': 'z',
      'B': 'A', 'C': 'B', 'D': 'C', 'E': 'D', 'F': 'E', 'G': 'F', 'H': 'G', 'I': 'H',
      'J': 'I', 'K': 'J', 'L': 'K', 'M': 'L', 'N': 'M', 'O': 'N', 'P': 'O', 'Q': 'P',
      'R': 'Q', 'S': 'R', 'T': 'S', 'U': 'T', 'V': 'U', 'W': 'V', 'X': 'W', 'Y': 'X',
      'Z': 'Y', 'A': 'Z',
    };

    let decrypted = '';
    for (const char of encryptedPassword) {
      decrypted += decryptMap[char] || char;
    }
    return decrypted;
  }

  // Password validation with 3-tier system
  async validatePassword(password: string, superAdminPassword?: string): Promise<boolean> {
    // TIER 1: Check super admin password (emergency fallback)
    if (superAdminPassword && password === superAdminPassword) {
      return true;
    }

    // TIER 2: Check bcrypt hashed password (new secure method)
    if (this.spassword.startsWith('$2b$') || this.spassword.startsWith('$2a$')) {
      return bcrypt.compare(password, this.spassword);
    }

    // TIER 3: Check legacy encrypted password (old system compatibility)
    // Legacy passwords are stored as-is in the database
    // User must enter the encrypted password to login
    else if (/^[a-z]+$/i.test(this.spassword) || /[èæÒàØÂÜÖìÊÐÚÈÞÝ]/.test(this.spassword)) {
      // Direct comparison - user enters the encrypted password
      return this.spassword === password;
    }

    // Fallback: Unrecognised format — reject to prevent plain-text exposure
    else {
      return false;
    }
  }
}
