import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
} from 'typeorm';

// userId points at usermaster.userid — no FK relation here since usermaster is
// a separate legacy entity; UserManagementService resolves the username/name
// summary manually where needed.
@Entity('user_activities')
export class UserActivity {
  @PrimaryGeneratedColumn()
  id: number;

  @Column()
  userId: number;

  @Column()
  activityType: string;

  @Column('text')
  description: string;

  @Column({ nullable: true })
  ipAddress: string;

  @Column('text', { nullable: true })
  userAgent: string;

  @CreateDateColumn()
  createdAt: Date;
}
