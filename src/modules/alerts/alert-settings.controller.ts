import { BadRequestException, Body, Controller, Get, Param, Post, Put, Req, UseGuards } from '@nestjs/common';
import { ApiTags, ApiOperation } from '@nestjs/swagger';
import { IsBoolean, IsIn, IsNumber, IsOptional } from 'class-validator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RoleGuard } from '../auth/guards/role.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { UserRole } from '../auth/entities/user.entity';
import { AlertSettingsService } from './alert-settings.service';
import { AlertService } from './alert.service';
import { AlertGroup } from './alert-catalog';
import { TelegramClientService } from './telegram-client.service';
import { DiscordClientService } from './discord-client.service';
import { JiraClientService } from '../support/services/jira-client.service';

class UpdateAlertSettingDto {
    @IsOptional()
    @IsBoolean()
    enabled?: boolean;

    @IsOptional()
    @IsNumber()
    param?: number;

    @IsOptional()
    @IsBoolean()
    telegram?: boolean;

    @IsOptional()
    @IsBoolean()
    discord?: boolean;
}

class UpdateGroupDto {
    @IsBoolean()
    enabled: boolean;

    // When given, only that destination's switches change (the other channel is left alone).
    @IsOptional()
    @IsIn(['telegram', 'discord'])
    dest?: 'telegram' | 'discord';
}

// Administrators only: this decides what reaches the company Telegram/Discord and whether Jira tickets are created.
@ApiTags('Alert Settings')
@Controller('alert-settings')
@UseGuards(JwtAuthGuard, RoleGuard)
@Roles(UserRole.ADMIN)
export class AlertSettingsController {
    constructor(
        private readonly settings: AlertSettingsService,
        private readonly alerts: AlertService,
        private readonly telegram: TelegramClientService,
        private readonly discord: DiscordClientService,
        private readonly jira: JiraClientService,
    ) { }

    @ApiOperation({ summary: 'All alerts with their switches, thresholds, destinations and the Jira card' })
    @Get()
    list() {
        const settings = this.settings.list();
        return {
            ...settings,
            telegram: { enabled: settings.telegramEnabled, configured: this.telegram.isConfigured(), channels: this.telegram.channelsConfigured() },
            discord: { enabled: settings.discordEnabled, configured: this.discord.anyConfigured(), channels: this.discord.channelsConfigured() },
            jira: { enabled: settings.jiraEnabled, ...this.jira.describe() },
            // kept for older clients
            telegramConfigured: this.telegram.isConfigured(),
        };
    }

    @ApiOperation({ summary: 'Send one test message per channel to Telegram or Discord' })
    @Post('test/:dest')
    test(@Param('dest') dest: string) {
        if (dest !== 'telegram' && dest !== 'discord') throw new BadRequestException('Destination must be telegram or discord');
        const queued = dest === 'telegram'
            ? (this.telegram.isConfigured() ? 5 : 0)
            : Object.values(this.discord.channelsConfigured()).filter(Boolean).length;
        // The messages are spaced out to respect rate limits, so answer at once.
        if (queued > 0) void this.alerts.sendTest(dest).catch(() => 0);
        return { queued };
    }

    @ApiOperation({ summary: 'Who is online right now (from the app heartbeat)' })
    @Get('online')
    online() {
        return { users: this.alerts.onlineNow() };
    }

    @ApiOperation({ summary: 'Post the "who is online" list to the channels that receive it' })
    @Post('online/post')
    postOnline() {
        return { count: this.alerts.sendOnlineSnapshot() };
    }

    @ApiOperation({ summary: 'Check the Jira login and project without creating a ticket' })
    @Post('jira/test')
    async testJira() {
        return this.jira.testConnection();
    }

    @ApiOperation({ summary: 'Switch a whole group of alerts on or off' })
    @Put('group/:group')
    async group(@Param('group') group: string, @Body() dto: UpdateGroupDto, @Req() req: any) {
        const by = req.user?.username ?? 'unknown';
        if (dto.dest) await this.settings.updateGroupDest(group as AlertGroup, dto.dest, dto.enabled, by);
        else await this.settings.updateGroup(group as AlertGroup, dto.enabled, by);
        return this.list();
    }

    @ApiOperation({ summary: 'Change one setting: an alert (on/off, threshold, destinations) or master / dest.telegram / dest.discord / jira.create' })
    @Put(':key')
    async update(@Param('key') key: string, @Body() dto: UpdateAlertSettingDto, @Req() req: any) {
        await this.settings.update(key, dto, req.user?.username ?? 'unknown');
        return this.list();
    }
}
