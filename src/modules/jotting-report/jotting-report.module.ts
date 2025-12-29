import { Module } from '@nestjs/common';
import { JottingReportController } from './jotting-report.controller';
import { JottingReportService } from './jotting-report.service';

@Module({
  controllers: [JottingReportController],
  providers: [JottingReportService],
  exports: [JottingReportService],
})
export class JottingReportModule {}