import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ScheduleModule } from '@nestjs/schedule';
import { AdminController } from './admin.controller';
import { AdminService } from './admin.service';
import { UserManagementController } from './controllers/user-management.controller';
import { SystemConfigController } from './controllers/system-config.controller';
import { DayEndController } from './controllers/day-end.controller';
import { BackupController } from './controllers/backup.controller';
import { UserManagementService } from './services/user-management.service';
import { SystemConfigService } from './services/system-config.service';
import { DayEndService } from './services/day-end.service';
import { BackupService } from './services/backup.service';
import { User } from '../auth/entities/user.entity';
import { UserActivity } from './entities/user-activity.entity';
import { SystemConfig } from './entities/system-config.entity';
import { InterestRate } from './entities/interest-rate.entity';
import { DepositSlab } from './entities/deposit-slab.entity';
import { DayEndProcess } from './entities/day-end-process.entity';
import { InterestPosting } from './entities/interest-posting.entity';
import { LoanAccount } from '../loan/entities/loan-account.entity';
import { FixedDeposit } from '../deposit/entities/fixed-deposit.entity';
import { Member } from '../member/entities/member.entity';

@Module({
  imports: [
    ScheduleModule.forRoot(),
    TypeOrmModule.forFeature([
      User,
      UserActivity,
      SystemConfig,
      InterestRate,
      DepositSlab,
      DayEndProcess,
      InterestPosting,
      LoanAccount,
      FixedDeposit,
      Member,
    ]),
  ],
  controllers: [
    AdminController,
    UserManagementController,
    SystemConfigController,
    DayEndController,
    BackupController,
  ],
  providers: [
    AdminService,
    UserManagementService,
    SystemConfigService,
    DayEndService,
    BackupService,
  ],
  exports: [
    AdminService,
    UserManagementService,
    SystemConfigService,
    DayEndService,
    BackupService,
  ],
})
export class AdminModule {}
