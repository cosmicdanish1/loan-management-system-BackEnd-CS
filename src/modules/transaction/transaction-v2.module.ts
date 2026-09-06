import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AdminModule } from '../admin/admin.module';
import { NotificationModule } from '../notification/notification.module';
// Loan disbursement withholds any RD/Share shortfall — the rule itself is
// owned by LoanEligibilityService, exported from LoanV2Module.
import { LoanV2Module } from '../loan/loan-v2.module';
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
    FixedDepositService
} from './services-v2';
import { MemberBalanceTransferService } from './services-v2/member-balance-transfer.service';
import { CompulsoryDepositController } from './compulsory-deposit.controller';
import { JournalTransferController } from './journal-transfer.controller';
import { FixedDepositController } from './fixed-deposit.controller';

@Module({
    imports: [
        AdminModule,
        NotificationModule,
        LoanV2Module,
        TypeOrmModule.forFeature([
            Transaction,
            Voucher,
            DemandMaster,
            ShortRecoveryAdjustment,
            MemberMaster
        ]),
    ],
    controllers: [
        TransactionV2Controller,
        ShortRecoveryController,
        DemandGenerationController, // Register
        LedgerPostingController, // Register
        DemandReportController, // Register
        CompulsoryDepositController,
        JournalTransferController,
        FixedDepositController
    ],
    providers: [
        VoucherService,
        PassTransactionService,
        ShortRecoveryService,
        DemandGenerationService,
        LedgerPostingService,
        DemandReportService,
        CompulsoryDepositService,
        JournalTransferService,
        FixedDepositService,
        MemberBalanceTransferService,
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
        FixedDepositService
    ]
})
export class TransactionV2Module { }
