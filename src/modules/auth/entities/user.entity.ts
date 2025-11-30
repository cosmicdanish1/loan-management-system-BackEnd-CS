import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  BeforeInsert,
  BeforeUpdate,
} from 'typeorm';
import * as bcrypt from 'bcrypt';

export enum UserRole {
  ADMIN = 'admin',
  MANAGER = 'manager',
  LOAN_OFFICER = 'loan_officer',
  ACCOUNTANT = 'accountant',
  DATA_OPERATOR = 'data_operator',
}

export enum UserPermission {
  // Member permissions
  CREATE_MEMBER = 'create_member',
  READ_MEMBER = 'read_member',
  UPDATE_MEMBER = 'update_member',
  DELETE_MEMBER = 'delete_member',
  
  // Loan permissions
  CREATE_LOAN = 'create_loan',
  READ_LOAN = 'read_loan',
  UPDATE_LOAN = 'update_loan',
  DELETE_LOAN = 'delete_loan',
  APPROVE_LOAN = 'approve_loan',
  
  // Deposit permissions
  CREATE_DEPOSIT = 'create_deposit',
  READ_DEPOSIT = 'read_deposit',
  UPDATE_DEPOSIT = 'update_deposit',
  DELETE_DEPOSIT = 'delete_deposit',
  
  // Transaction permissions
  CREATE_TRANSACTION = 'create_transaction',
  READ_TRANSACTION = 'read_transaction',
  UPDATE_TRANSACTION = 'update_transaction',
  DELETE_TRANSACTION = 'delete_transaction',
  
  // Report permissions
  GENERATE_REPORTS = 'generate_reports',
  VIEW_FINANCIAL_REPORTS = 'view_financial_reports',
  
  // Admin permissions
  MANAGE_USERS = 'manage_users',
  MANAGE_SYSTEM_CONFIG = 'manage_system_config',
  PERFORM_BACKUP = 'perform_backup',
  DAY_END_OPERATIONS = 'day_end_operations',
}

@Entity('users')
export class User {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ unique: true })
  username: string;

  @Column({ unique: true })
  email: string;

  @Column()
  password: string;

  @Column()
  firstName: string;

  @Column()
  lastName: string;

  @Column({
    type: 'varchar',
    default: UserRole.DATA_OPERATOR,
  })
  role: UserRole;

  @Column('simple-array', { nullable: true })
  permissions: UserPermission[];

  @Column({ default: true })
  isActive: boolean;

  @Column({ nullable: true })
  lastLoginAt: Date;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;

  @BeforeInsert()
  @BeforeUpdate()
  async hashPassword() {
    if (this.password) {
      const saltRounds = 12;
      this.password = await bcrypt.hash(this.password, saltRounds);
    }
  }

  async validatePassword(password: string): Promise<boolean> {
    return bcrypt.compare(password, this.password);
  }

  get fullName(): string {
    return `${this.firstName} ${this.lastName}`;
  }

  hasPermission(permission: UserPermission): boolean {
    return this.permissions?.includes(permission) || false;
  }

  hasAnyPermission(permissions: UserPermission[]): boolean {
    return permissions.some(permission => this.hasPermission(permission));
  }
}
