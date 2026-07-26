import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as fs from 'fs';
import * as path from 'path';

@Injectable()
export class ClientLogsService {
  private readonly logger = new Logger(ClientLogsService.name);
  private readonly logDir: string;

  constructor(private readonly configService: ConfigService) {
    this.logDir = path.join(
      this.configService.get('LOG_FILE_PATH', './logs'),
      'clients',
    );
    this.ensureDir();
  }

  private ensureDir(): void {
    try {
      if (!fs.existsSync(this.logDir)) {
        fs.mkdirSync(this.logDir, { recursive: true });
      }
    } catch (err) {
      this.logger.error(`Failed to create client logs directory: ${err}`);
    }
  }

  async writeClientLogs(
    hostname: string,
    entries: Array<{
      level: string;
      route: string;
      message: string;
      timestamp: string;
      data?: any;
    }>,
  ): Promise<void> {
    const safeHostname = hostname.replace(/[^a-zA-Z0-9._-]/g, '_');
    const logFile = path.join(this.logDir, `${safeHostname}.log`);

    const lines = entries
      .map((e) => {
        const data = e.data ? ` ${JSON.stringify(e.data)}` : '';
        return `[${e.timestamp}] [${e.level}] [${e.route}] ${e.message}${data}`;
      })
      .join('\n') + '\n';

    try {
      await fs.promises.appendFile(logFile, lines, 'utf-8');
    } catch (err) {
      this.logger.error(`Failed to write client logs for ${safeHostname}: ${err}`);
    }
  }
}
