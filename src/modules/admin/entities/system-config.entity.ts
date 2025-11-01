import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  Unique,
} from 'typeorm';

export enum ConfigCategory {
  INTEREST_RATES = 'interest_rates',
  DEPOSIT_SLABS = 'deposit_slabs',
  LOAN_SETTINGS = 'loan_settings',
  SYSTEM_SETTINGS = 'system_settings',
  BUSINESS_RULES = 'business_rules',
}

export enum ConfigDataType {
  STRING = 'string',
  NUMBER = 'number',
  BOOLEAN = 'boolean',
  JSON = 'json',
  PERCENTAGE = 'percentage',
}

@Entity('system_configs')
@Unique(['key'])
export class SystemConfig {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ unique: true })
  key: string;

  @Column()
  name: string;

  @Column('text', { nullable: true })
  description: string;

  @Column('text')
  value: string;

  @Column({
    type: 'varchar',
    enum: ConfigDataType,
    default: ConfigDataType.STRING,
  })
  dataType: ConfigDataType;

  @Column({
    type: 'varchar',
    enum: ConfigCategory,
    default: ConfigCategory.SYSTEM_SETTINGS,
  })
  category: ConfigCategory;

  @Column({ default: true })
  isActive: boolean;

  @Column({ default: false })
  isReadonly: boolean;

  @Column('text', { nullable: true })
  validationRules: string; // JSON string for validation rules

  @Column({ nullable: true })
  defaultValue: string;

  @Column({ nullable: true })
  unit: string; // e.g., '%', 'days', 'amount'

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;

  // Helper method to get typed value
  getTypedValue(): any {
    switch (this.dataType) {
      case ConfigDataType.NUMBER:
      case ConfigDataType.PERCENTAGE:
        return parseFloat(this.value);
      case ConfigDataType.BOOLEAN:
        return this.value === 'true';
      case ConfigDataType.JSON:
        try {
          return JSON.parse(this.value);
        } catch {
          return null;
        }
      case ConfigDataType.STRING:
      default:
        return this.value;
    }
  }

  // Helper method to set typed value
  setTypedValue(value: any): void {
    switch (this.dataType) {
      case ConfigDataType.JSON:
        this.value = JSON.stringify(value);
        break;
      case ConfigDataType.BOOLEAN:
        this.value = value ? 'true' : 'false';
        break;
      default:
        this.value = String(value);
    }
  }
}
