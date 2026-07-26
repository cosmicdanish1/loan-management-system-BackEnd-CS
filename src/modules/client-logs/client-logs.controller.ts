import { Controller, Post, Body, Logger, Req } from '@nestjs/common';
import { ApiTags, ApiOperation } from '@nestjs/swagger';
import { Request } from 'express';
import { ClientLogsService } from './client-logs.service';

class ClientLogEntryDto {
  level: string;
  route: string;
  message: string;
  timestamp: string;
  data?: any;
}

class ClientLogBatchDto {
  hostname: string;
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
