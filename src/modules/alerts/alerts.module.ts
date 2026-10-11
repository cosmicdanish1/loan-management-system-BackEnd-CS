import { Global, Module } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { AlertService } from './alert.service';
import { AlertsSchedulerService } from './alerts-scheduler.service';
import { SlowCallInterceptor } from './slow-call.interceptor';
import { TelegramClientService } from './telegram-client.service';

/** Global: AlertService is injectable anywhere; code outside DI uses AlertBridge. */
@Global()
@Module({
    providers: [
        TelegramClientService,
        AlertService,
        AlertsSchedulerService,
        { provide: APP_INTERCEPTOR, useClass: SlowCallInterceptor },
    ],
    exports: [TelegramClientService, AlertService],
})
export class AlertsModule { }
