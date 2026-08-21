import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DashboardNotice } from './entities/dashboard-notice.entity';
import { NoticeService } from './services/notice.service';
import { NoticeController } from './controllers/notice.controller';

@Module({
    imports: [TypeOrmModule.forFeature([DashboardNotice])],
    controllers: [NoticeController],
    providers: [NoticeService],
    exports: [NoticeService],
})
export class NoticeModule { }
