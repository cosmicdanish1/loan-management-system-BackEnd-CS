import { Controller, Post, Body, Logger, Req } from '@nestjs/common';
import { ApiTags, ApiOperation } from '@nestjs/swagger';
import { Request } from 'express';
import { Type } from 'class-transformer';
import { IsArray, IsOptional, IsString, ValidateNested } from 'class-validator';
import { ClientLogsService } from './client-logs.service';

class ClientLogEntryDto {
  @IsString()
  level: string;

  @IsString()
  route: string;

  @IsString()
  message: string;

  @IsString()
  timestamp: string;

  @IsOptional()
  data?: any;
}

class ClientLogBatchDto {
  @IsOptional()
  @IsString()
  hostname: string;

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ClientLogEntryDto)
  entries: ClientLogEntryDto[];
}

@ApiTags('Client Logs')
@Controller('client-logs')
export class ClientLogsController {
  private readonly logger = new Logger(ClientLogsController.name);

  constructor(private readonly clientLogsService: ClientLogsService) {}

  @ApiOperation({ summary: 'Ingest a batch of client-side (desktop app) log entries' })
  @Post()
  async receiveClientLogs(
    @Body() batch: ClientLogBatchDto,
    @Req() req: Request,
  ): Promise<{ received: number }> {
    const hostname = batch.hostname || req.ip || 'unknown';
    const entries = Array.isArray(batch.entries) ? batch.entries : [];

    if (entries.length === 0) {
      return { received: 0 };
    }

    this.logger.debug(`Received ${entries.length} log entries from ${hostname}`);
    await this.clientLogsService.writeClientLogs(hostname, entries);

    return { received: entries.length };
  }
}
