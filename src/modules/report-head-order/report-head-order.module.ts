import { Global, Module } from '@nestjs/common';
import { ReportHeadOrderController } from './report-head-order.controller';
import { ReportHeadOrderService } from './report-head-order.service';

// Global so every report service can inject ReportHeadOrderService without re-importing the module.
@Global()
@Module({
  controllers: [ReportHeadOrderController],
  providers: [ReportHeadOrderService],
  exports: [ReportHeadOrderService],
})
export class ReportHeadOrderModule {}
