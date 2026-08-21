import { Global, Module } from '@nestjs/common';
import { AuditLogService } from './audit.service';
import { ServiceLogService } from './service-log.service';
import { LogRetentionService } from './log-retention.service';
import { HttpAccessLogInterceptor } from '../interceptors/http-access-log.interceptor';

@Global()
@Module({
  providers: [AuditLogService, ServiceLogService, LogRetentionService, HttpAccessLogInterceptor],
  exports: [AuditLogService, ServiceLogService, LogRetentionService, HttpAccessLogInterceptor],
})
export class LoggingModule {}
