import { Global, Module } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { JiraClientService } from '../support/services/jira-client.service';
import { AlertService } from './alert.service';
import { AlertSettingsController } from './alert-settings.controller';
import { AlertSettingsService } from './alert-settings.service';
import { AlertsSchedulerService } from './alerts-scheduler.service';
import { DiscordClientService } from './discord-client.service';
import { SlowCallInterceptor } from './slow-call.interceptor';
import { TelegramClientService } from './telegram-client.service';

/** Global: AlertService is injectable anywhere; code outside DI uses AlertBridge. */
@Global()
@Module({
    controllers: [AlertSettingsController],
    providers: [
        TelegramClientService,
        DiscordClientService,
        // Stateless (reads .env); a second instance here lets Settings test the Jira connection
        // without importing SupportModule.
        JiraClientService,
        AlertSettingsService,
        AlertService,
        AlertsSchedulerService,
        { provide: APP_INTERCEPTOR, useClass: SlowCallInterceptor },
    ],
    exports: [TelegramClientService, DiscordClientService, AlertSettingsService, AlertService],
})
export class AlertsModule { }
