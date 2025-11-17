import {
  Entity,
  Column,
  PrimaryColumn,
  ManyToOne,
  JoinColumn,
  CreateDateColumn,
} from 'typeorm';
import { UserMaster } from './user-master.entity';

@Entity('logintime')
export class LoginTime {
  @PrimaryColumn({ name: 'login_date', type: 'timestamp' })
  loginDate: Date;

  @PrimaryColumn({ name: 'userid', type: 'smallint' })
  userid: number;

  @Column({ name: 'login_time', type: 'varchar', length: 12, default: '' })
  loginTime: string;

  @Column({ name: 'logout_time', type: 'varchar', length: 12, default: '' })
  logoutTime: string;

  // Relationships
  @ManyToOne(() => UserMaster, (user) => user.loginTimes)
  @JoinColumn({ name: 'userid' })
  user: UserMaster;

  // Computed properties
  get isActive(): boolean {
    return !this.logoutTime || this.logoutTime === '';
  }

  get sessionDuration(): number | null {
    if (!this.loginTime || !this.logoutTime || this.logoutTime === '') {
      return null;
    }

    try {
      const loginParts = this.loginTime.split(':');
      const logoutParts = this.logoutTime.split(':');

      const loginMinutes =
        parseInt(loginParts[0]) * 60 + parseInt(loginParts[1]);
      const logoutMinutes =
        parseInt(logoutParts[0]) * 60 + parseInt(logoutParts[1]);

      return logoutMinutes - loginMinutes;
    } catch {
      return null;
    }
  }

  // Helper to check if session is for today
  isToday(): boolean {
    const today = new Date();
    const loginDate = new Date(this.loginDate);

    return (
      loginDate.getDate() === today.getDate() &&
      loginDate.getMonth() === today.getMonth() &&
      loginDate.getFullYear() === today.getFullYear()
    );
  }
}
