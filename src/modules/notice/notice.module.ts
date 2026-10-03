import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DashboardNotice } from './entities/dashboard-notice.entity';
import { NoticeService } from './services/notice.service';
import { NoticeController } from './controllers/notice.controller';
import { DashboardSummaryService } from './services/dashboard-summary.service';
import { DashboardSummaryController } from './controllers/dashboard-summary.controller';

@Module({
    imports: [TypeOrmModule.forFeature([DashboardNotice])],
    controllers: [NoticeController, DashboardSummaryController],
    providers: [NoticeService, DashboardSummaryService],
    exports: [NoticeService],
})
export class NoticeModule { }
