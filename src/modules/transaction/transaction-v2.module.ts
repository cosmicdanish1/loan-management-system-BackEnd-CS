import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AdminModule } from '../admin/admin.module';
import { NotificationModule } from '../notification/notification.module';
import { Transaction } from './entities/transaction.entity';
import { Voucher } from './entities/voucher.entity';
import { DemandMaster } from './entities/demand-master.entity';
import { ShortRecoveryAdjustment } from './entities/short-recovery-adjustment.entity';
import { MemberMaster } from '../member/entities/member-master.entity';
import { TransactionV2Controller } from './transaction-v2.controller';
import { ShortRecoveryController } from './short-recovery.controller';
import { DemandGenerationController } from './demand-generation.controller'; // New
import { LedgerPostingController } from './ledger-posting.controller'; // New
import { DemandReportController } from './demand-report.controller'; // New
import {
    VoucherService,
    PassTransactionService,
    ShortRecoveryService,
    DemandGenerationService,
    LedgerPostingService,
    DemandReportService,
    CompulsoryDepositService,
    JournalTransferService,
    DividendPaymentService,
} from './services-v2';
import { DemandImportService } from './services-v2/demand-import.service';
import { LoanEligibilityService } from '../loan/services-v2/loan-eligibility.service';
import { LoanRepaymentService } from '../loan/services-v2/loan-repayment.service';
import { RdModule } from '../rd/rd.module';
import { CompulsoryDepositController } from './compulsory-deposit.controller';
import { JournalTransferController } from './journal-transfer.controller';
import { DividendPaymentController } from './dividend-payment.controller';

@Module({
    imports: [
        AdminModule,
        NotificationModule,
        TypeOrmModule.forFeature([
            Transaction,
            Voucher,
            DemandMaster,
            ShortRecoveryAdjustment,
            MemberMaster
        ]),
        RdModule,
    ],
    controllers: [
        TransactionV2Controller,
        ShortRecoveryController,
        DemandGenerationController, // Register
        LedgerPostingController, // Register
        DemandReportController, // Register
        CompulsoryDepositController,
        JournalTransferController,
        DividendPaymentController,
    ],
    providers: [
        VoucherService,
        PassTransactionService,
        ShortRecoveryService,
        DemandGenerationService, // Register
        DemandImportService,
        LedgerPostingService, // Register
        DemandReportService, // Register
        CompulsoryDepositService,
        JournalTransferService,
        DividendPaymentService,
        LoanEligibilityService,
        // Same duplicated-provider pattern as LoanEligibilityService above —
        // PassTransactionService needs calculateEarlyClosure() (a pure,
        // read-only quote) to price a same-type old loan's NR/AP/penal
        // interest at consolidation time, but importing the whole LoanV2Module
        // isn't needed since LoanRepaymentService's own dependencies
        // (DataSource, LoanEligibilityService, RdBalanceEventsService) are
        // already available in this module.
        LoanRepaymentService,
    ],
    exports: [
        VoucherService,
        PassTransactionService,
        ShortRecoveryService,
        DemandGenerationService,
        LedgerPostingService,
        DemandReportService,
        CompulsoryDepositService,
        JournalTransferService,
        DividendPaymentService,
        LoanEligibilityService,
    ]
})
export class TransactionV2Module { }
