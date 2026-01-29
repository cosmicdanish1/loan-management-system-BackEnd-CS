import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ScheduleModule } from '@nestjs/schedule';
import { AdminController } from './admin.controller';
import { AdminService } from './admin.service';
import { UserManagementController } from './controllers/user-management.controller';
import { SystemConfigController } from './controllers/system-config.controller';
import { DayEndController } from './controllers/day-end.controller';
import { BackupController } from './controllers/backup.controller';
import { CertificateTemplateController } from './controllers/certificate-template.controller';
import { PassbookTemplateController } from './controllers/passbook-template.controller';
import { RoleManagementController } from './controllers/role-management.controller';
import { DesignationController } from './controllers/designation.controller';
import { CastCategoryController } from './controllers/cast-category.controller';
import { MemberBalanceController } from './controllers/member-balance.controller';
import { FdAccountController } from './controllers/fd-account.controller';
import { OfficeController } from './controllers/office.controller';
import { WingController } from './controllers/wing.controller';
import { SbAccountController } from './controllers/sb-account.controller';
import { RdAccountController } from './controllers/rd-account.controller';
import { MemberAdminController } from './controllers/member-admin.controller';
import { MemberFundsController } from './controllers/member-funds.controller';
import { FinancialYearController } from './controllers/financial-year.controller';
import { UserManagementService } from './services/user-management.service';
import { SystemConfigService } from './services/system-config.service';
import { DayEndService } from './services/day-end.service';
import { BackupService } from './services/backup.service';
import { CertificateTemplateService } from './services/certificate-template.service';
import { PassbookTemplateService } from './services/passbook-template.service';
import { RoleManagementService } from './services/role-management.service';
import { DesignationService } from './services/designation.service';
import { CastCategoryService } from './services/cast-category.service';
import { MemberBalanceService } from './services/member-balance.service';
import { FdAccountService } from './services/fd-account.service';
import { OfficeService } from './services/office.service';
import { WingService } from './services/wing.service';
import { SbAccountService } from './services/sb-account.service';
import { RdAccountService } from './services/rd-account.service';
import { MemberAdminService } from './services/member-admin.service';
import { MemberFundsService } from './services/member-funds.service';
import { FinancialYearService } from './services/financial-year.service';
import { User } from '../auth/entities/user.entity';
import { UserMaster, UserLevelMaster, MenuMaster, UserLevelDefaultRights, LoginTime } from '../auth/entities';
import { UserActivity } from './entities/user-activity.entity';
import { SystemConfig } from './entities/system-config.entity';
import { InterestRate } from './entities/interest-rate.entity';
import { DepositSlab } from './entities/deposit-slab.entity';
import { DayEndProcess } from './entities/day-end-process.entity';
import { InterestPosting } from './entities/interest-posting.entity';
import { CertificateTemplate } from './entities/certificate-template.entity';
import { CertificateField } from './entities/certificate-field.entity';
import { PassbookTemplate, PassbookField, PassbookPagePosition, Designation, CastCategory, MemberBalance, FdAccount, BankMember, Office, Wing, SbAccount, RdAccount, FundsMaster, FinancialYear } from './entities';
import { LoanAccount } from '../loan/entities/loan-account.entity';
import { FixedDeposit } from '../deposit/entities/fixed-deposit.entity';
import { Member } from '../member/entities/member.entity';

@Module({
  imports: [
    ScheduleModule.forRoot(),
    TypeOrmModule.forFeature([
      User,
      UserMaster,
      UserLevelMaster,
      MenuMaster,
      UserLevelDefaultRights,
      LoginTime,
      UserActivity,
      SystemConfig,
      InterestRate,
      DepositSlab,
      DayEndProcess,
      InterestPosting,
      LoanAccount,
      FixedDeposit,
      Member,
      BankMember,
      CertificateTemplate,
      CertificateField,
      PassbookTemplate,
      PassbookField,
      PassbookPagePosition,
      Designation,
      CastCategory,
      MemberBalance,
      FdAccount,
      Office,
      Wing,
      SbAccount,
      RdAccount,
      FundsMaster,
      FinancialYear,
    ]),
  ],
  controllers: [
    AdminController,
    UserManagementController,
    SystemConfigController,
    DayEndController,
    BackupController,
    CertificateTemplateController,
    PassbookTemplateController,
    RoleManagementController,
    DesignationController,
    CastCategoryController,
    MemberBalanceController,
    FdAccountController,
    OfficeController,
    WingController,
    SbAccountController,
    RdAccountController,
    MemberAdminController,
    MemberFundsController,
    FinancialYearController,
  ],
  providers: [
    AdminService,
    UserManagementService,
    SystemConfigService,
    DayEndService,
    BackupService,
    CertificateTemplateService,
    PassbookTemplateService,
    RoleManagementService,
    DesignationService,
    CastCategoryService,
    MemberBalanceService,
    FdAccountService,
    OfficeService,
    WingService,
    SbAccountService,
    RdAccountService,
    MemberAdminService,
    MemberFundsService,
    FinancialYearService,
  ],
  exports: [
    AdminService,
    UserManagementService,
    SystemConfigService,
    DayEndService,
    BackupService,
    CertificateTemplateService,
    PassbookTemplateService,
    RoleManagementService,
    DesignationService,
    CastCategoryService,
    MemberBalanceService,
    FdAccountService,
    OfficeService,
    WingService,
    SbAccountService,
    RdAccountService,
    MemberAdminService,
    MemberFundsService,
    FinancialYearService,
  ],
})
export class AdminModule { }
