import { Global, Module } from '@nestjs/common';
import { AuditLogService } from './audit.service';
import { ServiceLogService } from './service-log.service';

@Global()
@Module({
  providers: [AuditLogService, ServiceLogService],
  exports: [AuditLogService, ServiceLogService],
})
export class LoggingModule {}
