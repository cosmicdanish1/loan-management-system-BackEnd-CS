import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ReportController } from './report.controller';
import { ReportService } from './report.service';
import { CashBook } from './entities/cash-book.entity';
import { HeadMaster } from '../print-voucher/entities/head-master.entity';
import { Ledger } from '../print-voucher/entities/ledger.entity';
import { LoanMaster } from '../loan/entities/loan-master.entity';
import { MemberMaster } from '../member/entities/member-master.entity';
import { ReportScheduleHeader } from './entities/report-schedule-header.entity';
import { ReportScheduleDetail } from './entities/report-schedule-detail.entity';

@Module({
  imports: [TypeOrmModule.forFeature([CashBook, HeadMaster, Ledger, LoanMaster, MemberMaster, ReportScheduleHeader, ReportScheduleDetail])],
  controllers: [ReportController],
  providers: [ReportService],
})
export class ReportModule { }
